import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  CreateStudyConversationBody,
  SendConversationMessageBody,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import {
  conversationMessagesTable,
  conversationsTable,
  conceptsTable,
  sourcesTable,
  topicsTable,
  unitConceptsTable,
  unitsTable,
  type StudyCitation,
} from "@workspace/db/schema";
import { logger } from "../lib/logger";
import {
  cachedAI,
  modelConfig,
  openai,
  sha256,
  visionSlot,
  withRetry,
} from "../lib/ingestion/ai";
import {
  findOwnedConversation,
  findOwnedCourse,
  studygraphPathParam,
  studygraphOwnerId,
  validStudygraphId,
} from "../lib/studygraph/ownership";
import {
  citationFor,
  retrieveRelevantUnits,
  type GroundedUnit,
  loadUnitsByIds,
} from "../lib/studygraph/retrieval";

const router: IRouter = Router();

/** Extract the text of a photographed question; the normal tutor then answers from retrieved course sources. */
router.post("/courses/:courseId/tutor/photo-question", async (req: Request, res: Response) => {
  const ownerId = studygraphOwnerId(res);
  const courseId = studygraphPathParam(req, "courseId");
  if (!validStudygraphId(courseId) || !(await findOwnedCourse(courseId, ownerId))) {
    res.status(404).json({ error: "Course not found." });
    return;
  }
  const imageDataUrl = typeof req.body?.imageDataUrl === "string" ? req.body.imageDataUrl : "";
  const match = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(imageDataUrl);
  if (!match || imageDataUrl.length > 7_000_000) {
    res.status(400).json({ error: "Choose a JPG, PNG, or WebP photo smaller than 5 MB." });
    return;
  }
  const visionModels = [...new Set([
    modelConfig.vision,
    "meta-llama/llama-4-maverick-17b-128e-instruct",
    "meta-llama/llama-4-scout-17b-16e-instruct",
  ])];
  let lastError: unknown;
  let unreadable = false;
  for (const model of visionModels) {
    try {
      const response = await visionSlot(() => withRetry(() => openai().chat.completions.create({
        model,
        max_completion_tokens: 700,
        temperature: 0,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Read the question in this photo. Copy its words, numbers, units, and answer choices accurately. Do not solve it. Return only the question text. If the image is unclear, say so in a few simple words." },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        }],
      }), 1));
      const question = response.choices[0]?.message?.content?.trim() ?? "";
      if (question.length >= 3 && !/unreadable|can't read|cannot read/i.test(question)) {
        res.json({ question: question.slice(0, 5_000) });
        return;
      }
      unreadable = true;
    } catch (error) {
      lastError = error;
      logger.info({ error, courseId, model }, "A photo-reading model failed; trying the next model");
    }
  }
  if (unreadable) {
    res.status(422).json({ error: "I couldn't read the words clearly. Your photo is still attached—try a sharper photo or type the question." });
    return;
  }
  logger.warn({ error: lastError, courseId }, "All photo-reading models failed");
  res.status(503).json({ error: "I couldn't read the photo right now. Your photo is still attached—type the question and I can help from your course notes." });
});

function messageDto(message: typeof conversationMessagesTable.$inferSelect) {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    citations: message.citations,
    createdAt: message.createdAt,
  };
}

function parseTutorResult(value: string): {
  answerable: boolean;
  answer: string;
  citationUnitIds: string[];
} | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.answerable !== "boolean" ||
      typeof record.answer !== "string" ||
      !Array.isArray(record.citationUnitIds)
    ) {
      return null;
    }
    return {
      answerable: record.answerable,
      answer: record.answer.trim(),
      citationUnitIds: record.citationUnitIds
        .filter((item): item is string | number => typeof item === "string" || typeof item === "number")
        .map((item) => String(item)),
    };
  } catch {
    return null;
  }
}

async function saveTurn(
  conversationId: string,
  ownerId: string,
  currentTitle: string,
  userContent: string,
  assistantContent: string,
  citations: StudyCitation[],
) {
  // Explicit, distinct timestamps: rows inserted in one transaction otherwise share now(),
  // which let the answer sort above the question.
  const userAt = new Date();
  const assistantAt = new Date(userAt.getTime() + 25);
  return db.transaction(async (tx) => {
    const [userMessage] = await tx
      .insert(conversationMessagesTable)
      .values({ conversationId, role: "user", content: userContent, citations: [], createdAt: userAt })
      .returning();
    const [assistantMessage] = await tx
      .insert(conversationMessagesTable)
      .values({
        conversationId,
        role: "assistant",
        content: assistantContent,
        citations,
        createdAt: assistantAt,
      })
      .returning();
    await tx
      .update(conversationsTable)
      .set({
        updatedAt: new Date(),
        title:
          currentTitle === "New study session" && userContent.length > 2
            ? userContent.split(/\r?\n/, 1)[0].slice(0, 76)
            : currentTitle,
      })
      .where(
        and(
          eq(conversationsTable.id, conversationId),
          eq(conversationsTable.ownerId, ownerId),
        ),
      );
    return { userMessage, assistantMessage };
  });
}

const NOTE_AT_END = /\n\n\(Please answer in [\s\S]*\)\s*$/;
const stripNote = (text: string) => text.replace(NOTE_AT_END, "").trim();
type TutorLanguage = "en" | "hi" | "hinglish" | "ta" | "te" | "bn" | "mr";
const LANGUAGE_COPY: Record<TutorLanguage, { answer: string; notCovered: string; hasTopics: (topics: string) => string; noTopics: string; noSources: string; processing: string; failedSources: string; busy: string; excerptIntro: string; detailIntro: string; reviewTip: string; reviewHint: string; explain: (topic: string) => string }> = {
  en: {
    answer: "English.", notCovered: "I couldn't find that in your ready course material, so I don't want to guess.",
    hasTopics: (topics) => `Your material does cover ${topics}. Try one of the topics below, or ask using a term from the PDF.`,
    noTopics: "Try asking with a phrase from the PDF, or open a source citation to check what was extracted.",
    noSources: "I can't search this course yet because no source is ready. Please wait for the PDF to finish processing, then try again.",
    processing: "Your PDF is still being processed. It is uploaded, but I can answer from it once it shows Ready in the source library.",
    failedSources: "I can see the uploaded file, but it did not finish processing. Open the source library, retry processing, and ask again when it shows Ready.",
    busy: "Let’s make this easy to learn. Here is the main idea from your notes, followed by the details that explain it.",
    excerptIntro: "Main idea", detailIntro: "Details from your notes", reviewTip: "A simple way to review",
    reviewHint: "Read the main idea first. Then connect each detail to it. The source links below let you check the original notes.",
    explain: (topic) => `Explain ${topic} in simple words`,
  },
  hi: {
    answer: "हिंदी में उत्तर दें और देवनागरी लिपि का उपयोग करें। तकनीकी शब्दों को सही रखें और जहाँ उपयोगी हो, उनका सरल हिंदी अर्थ भी दें।",
    notCovered: "मुझे आपकी तैयार पाठ्य सामग्री में इसका उत्तर नहीं मिला, इसलिए मैं अनुमान नहीं लगाऊँगा।",
    hasTopics: (topics) => `आपकी सामग्री में ${topics} जैसे विषय हैं। नीचे दिए गए किसी विषय के बारे में पूछें या PDF का कोई शब्द लिखें।`,
    noTopics: "PDF में मौजूद कोई शब्द लिखकर पूछें, या स्रोत खोलकर देखें कि उसमें से क्या पढ़ा गया है।",
    noSources: "अभी इस पाठ्यक्रम में कोई तैयार स्रोत नहीं है। PDF का प्रसंस्करण पूरा होने के बाद फिर से पूछें।",
    processing: "आपकी PDF अभी तैयार हो रही है। स्रोत लाइब्रेरी में Ready दिखने पर मैं उससे उत्तर दे पाऊँगा।",
    failedSources: "अपलोड की गई फ़ाइल दिख रही है, लेकिन उसका प्रसंस्करण पूरा नहीं हुआ। स्रोत लाइब्रेरी में Retry processing चुनें और Ready होने पर फिर पूछें।",
    busy: "इसे आसान तरीके से समझते हैं। पहले आपकी सामग्री का मुख्य विचार है, फिर उसे समझाने वाले ज़रूरी विवरण हैं।",
    excerptIntro: "मुख्य विचार", detailIntro: "आपके नोट्स के ज़रूरी विवरण", reviewTip: "आसान तरीके से दोहराएँ",
    reviewHint: "पहले मुख्य विचार पढ़ें। फिर हर विवरण को उससे जोड़ें। मूल नोट्स देखने के लिए नीचे दिए गए स्रोत लिंक खोलें।",
    explain: (topic) => `${topic} को सरल भाषा में समझाइए`,
  },
  hinglish: {
    answer: "Hinglish mein jawab dein: Hindi ko Roman script mein likhein, aur technical English terms ko simple meaning ke saath samjhayen.",
    notCovered: "Mujhe aapke ready course material mein iska jawab nahi mila, isliye main guess nahi karunga.",
    hasTopics: (topics) => `Aapke material mein ${topics} jaise topics hain. Neeche kisi topic ke baare mein poochhein ya PDF ka exact word likhein.`,
    noTopics: "PDF mein diya hua koi exact word likhkar poochhein, ya source kholkar dekhein ki kya extract hua hai.",
    noSources: "Abhi course ka koi source Ready nahi hai. PDF processing complete hote hi phir se poochhein.",
    processing: "Aapki PDF abhi process ho rahi hai. Source library mein Ready dikhne par main usse answer kar paunga.",
    failedSources: "Uploaded file dikh rahi hai, lekin processing complete nahi hui. Source library mein Retry processing karein; Ready hone par phir poochhein.",
    busy: "Chaliye ise aasaan tareeke se samajhte hain. Pehle notes ka main idea hai, phir use samjhane wale zaroori details.",
    excerptIntro: "Main idea", detailIntro: "Aapke notes ke zaroori details", reviewTip: "Yaad rakhne ke liye",
    reviewHint: "Pehle main idea padhein. Phir har detail ko usse jodein. Original notes ke liye neeche source links dekhein.",
    explain: (topic) => `${topic} ko simple words mein samjhao`,
  },
  ta: {
    answer: "இயல்பான தமிழில் பதிலளிக்கவும். தொழில்நுட்பச் சொற்களைத் துல்லியமாக வைத்து, தேவையான இடங்களில் எளிய தமிழில் விளக்கவும்.",
    notCovered: "உங்கள் தயார் செய்யப்பட்ட பாடப் பொருளில் இதற்கான பதில் கிடைக்கவில்லை; அதனால் நான் ஊகிக்க விரும்பவில்லை.",
    hasTopics: (topics) => `உங்கள் பாடப் பொருளில் ${topics} போன்ற தலைப்புகள் உள்ளன. கீழே உள்ள தலைப்பைப் பற்றி கேளுங்கள் அல்லது PDF-இல் உள்ள சொல்லைப் பயன்படுத்துங்கள்.`,
    noTopics: "PDF-இல் உள்ள ஒரு சொல்லைப் பயன்படுத்தி கேளுங்கள் அல்லது பிரித்தெடுக்கப்பட்ட உள்ளடக்கத்தை மூலத்தில் சரிபாருங்கள்.",
    noSources: "இந்தப் பாடத்தில் இன்னும் தயாரான கோப்பு இல்லை. PDF செயலாக்கம் முடிந்ததும் மீண்டும் கேளுங்கள்.",
    processing: "உங்கள் PDF இன்னும் செயலாக்கப்படுகிறது. மூல நூலகத்தில் Ready எனக் காட்டியதும் அதிலிருந்து பதிலளிக்க முடியும்.",
    failedSources: "பதிவேற்றிய கோப்பு உள்ளது, ஆனால் அதன் செயலாக்கம் முடியவில்லை. மூல நூலகத்தில் மீண்டும் செயலாக்கி, Ready ஆனதும் கேளுங்கள்.",
    busy: "இதை எளிதாகப் புரிந்துகொள்வோம். முதலில் உங்கள் குறிப்புகளின் முக்கியக் கருத்து, பின்னர் அதை விளக்கும் விவரங்கள்.",
    excerptIntro: "முக்கியக் கருத்து", detailIntro: "உங்கள் குறிப்புகளில் உள்ள விவரங்கள்", reviewTip: "எளிதாக மீண்டும் படிக்க",
    reviewHint: "முதலில் முக்கியக் கருத்தைப் படிக்கவும். பிறகு ஒவ்வொரு விவரத்தையும் அதனுடன் இணைக்கவும். அசல் குறிப்புகளுக்கு கீழே உள்ள இணைப்புகளைப் பார்க்கவும்.",
    explain: (topic) => `${topic} எளிய சொற்களில் விளக்கவும்`,
  },
  te: {
    answer: "సహజమైన తెలుగులో సమాధానం ఇవ్వండి. సాంకేతిక పదాలను సరిగ్గా ఉంచి, అవసరమైనప్పుడు సులభమైన తెలుగులో అర్థం చెప్పండి.",
    notCovered: "మీ సిద్ధంగా ఉన్న కోర్సు మెటీరియల్‌లో దీనికి సమాధానం కనిపించలేదు; కాబట్టి నేను ఊహించి చెప్పను.",
    hasTopics: (topics) => `మీ మెటీరియల్‌లో ${topics} వంటి అంశాలు ఉన్నాయి. కింద ఉన్న అంశం గురించి అడగండి లేదా PDFలోని పదాన్ని ఉపయోగించండి.`,
    noTopics: "PDFలో ఉన్న పదంతో అడగండి లేదా మూలాన్ని తెరిచి అందులో ఏమి గుర్తించబడిందో చూడండి.",
    noSources: "ఈ కోర్సులో ఇంకా సిద్ధంగా ఉన్న ఫైల్ లేదు. PDF ప్రాసెసింగ్ పూర్తయ్యాక మళ్లీ అడగండి.",
    processing: "మీ PDF ఇంకా ప్రాసెస్ అవుతోంది. సోర్స్ లైబ్రరీలో Ready అని చూపిన తర్వాత దాని నుంచి సమాధానం ఇస్తాను.",
    failedSources: "అప్‌లోడ్ చేసిన ఫైల్ కనిపిస్తోంది, కానీ ప్రాసెసింగ్ పూర్తికాలేదు. సోర్స్ లైబ్రరీలో మళ్లీ ప్రాసెస్ చేసి Ready అయ్యాక అడగండి.",
    busy: "దీన్ని సులభంగా అర్థం చేసుకుందాం. ముందుగా మీ నోట్స్‌లోని ముఖ్యమైన ఆలోచన, తర్వాత దాన్ని వివరించే అంశాలు.",
    excerptIntro: "ముఖ్యమైన ఆలోచన", detailIntro: "మీ నోట్స్‌లోని వివరాలు", reviewTip: "సులభంగా మళ్లీ చదవడానికి",
    reviewHint: "ముందుగా ముఖ్యమైన ఆలోచనను చదవండి. తర్వాత ప్రతి వివరాన్ని దానికి అనుసంధానించండి. అసలు నోట్స్ కోసం కింద ఉన్న లింక్‌లను చూడండి.",
    explain: (topic) => `${topic}ను సులభంగా వివరించండి`,
  },
  bn: {
    answer: "স্বাভাবিক বাংলায় উত্তর দিন। প্রযুক্তিগত শব্দ ঠিক রাখুন এবং প্রয়োজন হলে সহজ বাংলায় অর্থ বুঝিয়ে দিন।",
    notCovered: "আপনার প্রস্তুত কোর্সের উপকরণে এর উত্তর খুঁজে পাইনি, তাই অনুমান করে বলতে চাই না।",
    hasTopics: (topics) => `আপনার উপকরণে ${topics}-এর মতো বিষয় রয়েছে। নিচের কোনো বিষয় নিয়ে জিজ্ঞাসা করুন বা PDF-এর শব্দ ব্যবহার করুন।`,
    noTopics: "PDF-এ থাকা কোনো শব্দ দিয়ে জিজ্ঞাসা করুন, অথবা উৎস খুলে কী তথ্য বের হয়েছে দেখুন।",
    noSources: "এই কোর্সে এখনো প্রস্তুত কোনো ফাইল নেই। PDF প্রক্রিয়াকরণ শেষ হলে আবার জিজ্ঞাসা করুন।",
    processing: "আপনার PDF এখনো প্রক্রিয়াধীন। সোর্স লাইব্রেরিতে Ready দেখালে আমি সেখান থেকে উত্তর দিতে পারব।",
    failedSources: "আপলোড করা ফাইলটি দেখা যাচ্ছে, কিন্তু প্রক্রিয়াকরণ শেষ হয়নি। সোর্স লাইব্রেরিতে আবার প্রক্রিয়া করুন; Ready হলে জিজ্ঞাসা করুন।",
    busy: "চলুন, বিষয়টি সহজভাবে বুঝি। প্রথমে আপনার নোটের মূল কথা, তারপর সেটি বোঝার জন্য দরকারি বিবরণ।",
    excerptIntro: "মূল কথা", detailIntro: "আপনার নোটের দরকারি বিবরণ", reviewTip: "সহজে মনে রাখার উপায়",
    reviewHint: "আগে মূল কথাটি পড়ুন। তারপর প্রতিটি বিবরণকে তার সঙ্গে মিলিয়ে নিন। মূল নোট দেখতে নিচের লিংকগুলো খুলুন।",
    explain: (topic) => `${topic} সহজ ভাষায় বুঝিয়ে দিন`,
  },
  mr: {
    answer: "नैसर्गिक मराठीत उत्तर द्या. तांत्रिक शब्द अचूक ठेवा आणि गरज असल्यास त्यांचा सोपा मराठी अर्थ सांगा.",
    notCovered: "तुमच्या तयार अभ्याससामग्रीत याचे उत्तर सापडले नाही, त्यामुळे मी अंदाज लावणार नाही.",
    hasTopics: (topics) => `तुमच्या सामग्रीत ${topics} यांसारखे विषय आहेत. खालील विषयाबद्दल विचारा किंवा PDF मधील शब्द वापरा.`,
    noTopics: "PDF मधील एखादा शब्द वापरून विचारा किंवा स्रोत उघडून त्यातून काय मजकूर मिळाला ते तपासा.",
    noSources: "या अभ्यासक्रमात अजून तयार स्रोत नाही. PDF प्रक्रिया पूर्ण झाल्यावर पुन्हा विचारा.",
    processing: "तुमची PDF अजून प्रक्रिया होत आहे. स्रोत लायब्ररीत Ready दिसल्यावर मी त्यातून उत्तर देऊ शकेन.",
    failedSources: "अपलोड केलेली फाइल दिसते, पण तिची प्रक्रिया पूर्ण झाली नाही. स्रोत लायब्ररीत पुन्हा प्रक्रिया करा आणि Ready झाल्यावर विचारा.",
    busy: "चला, हे सोप्या पद्धतीने समजून घेऊया. आधी तुमच्या नोंदीतील मुख्य कल्पना, मग ती समजावणारे तपशील.",
    excerptIntro: "मुख्य कल्पना", detailIntro: "तुमच्या नोंदीतील महत्त्वाचे तपशील", reviewTip: "सोप्या पद्धतीने उजळणी",
    reviewHint: "आधी मुख्य कल्पना वाचा. मग प्रत्येक तपशील तिच्याशी जोडा. मूळ नोंदी पाहण्यासाठी खालील लिंक उघडा.",
    explain: (topic) => `${topic} सोप्या भाषेत समजावून सांगा`,
  },
};

function requestedLanguage(text: string): TutorLanguage {
  const note = NOTE_AT_END.exec(text)?.[0]?.toLowerCase() ?? "";
  if (note.includes("hinglish")) return "hinglish";
  if (note.includes("hindi")) return "hi";
  if (note.includes("tamil")) return "ta";
  if (note.includes("telugu")) return "te";
  if (note.includes("bengali")) return "bn";
  if (note.includes("marathi")) return "mr";
  return "en";
}

function answerLanguageRule(language: TutorLanguage): string {
  const copy = LANGUAGE_COPY[language].answer;
  return `OUTPUT LANGUAGE REQUIREMENT: Write every part of the student-facing answer in ${language === "en" ? "English" : language === "hi" ? "Hindi" : language === "hinglish" ? "Hinglish" : language === "ta" ? "Tamil" : language === "te" ? "Telugu" : language === "bn" ? "Bengali" : "Marathi"}. ${copy} Do not switch to English just because the source material is English. Keep only technical names, formulas, and code in their original form.`;
}

async function englishSearchRewrite(question: string, language: TutorLanguage): Promise<string> {
  if (language === "en") return "";
  try {
    return await cachedAI<string>(
      `studygraph:tutor-search-rewrite:v1:${sha256(`${language}:${question.toLowerCase()}`)}`,
      modelConfig.tutor,
      async () => {
        const response = await withRetry(() => openai().chat.completions.create({
          model: modelConfig.tutor,
          max_completion_tokens: 160,
          temperature: 0,
          messages: [
            { role: "system", content: `Convert the student's search question from ${language} into concise English search terms suitable for finding matching passages in course notes. Preserve names, equations, and acronyms; expand an acronym only when its meaning is clear from the question. Do not answer the question. Return only one English search query, with no quotation marks or explanation.` },
            { role: "user", content: question.slice(0, 1_500) },
          ],
        }), 1);
        const value = response.choices[0]?.message?.content?.trim().replace(/^['"`]+|['"`]+$/g, "") ?? "";
        return value.length > 1 && value.length < 500 ? value : "";
      },
    );
  } catch (error) {
    logger.info({ language, error }, "Tutor search-language rewrite unavailable; using the original question");
    return "";
  }
}
const REWRITE_REQUEST =
  /\b(simpl(?:er|ify|e|y)|easy|easier|shorter|short|brief(?:ly)?|elaborate|more|detail(?:s|ed)?|again|rephrase|clarify|don'?t understand|samajh|dobara|aur|hindi|english|hinglish|translate|example|examples|continue|go on)\b/i;
const PRONOUN_REFERENCE = /\b(it|this|that|these|those|they|them|its|above|previous)\b/i;
const FILLER_WORDS = new Set(
  "what is are the and or of to in on for it this that these those you me please tell give say explain again more simple simply words word easy easier short shorter brief detail details example examples why how can could would does did they them its also just one".split(
    " ",
  ),
);

/** "more in simple words" or "why?" carry no topic of their own: detect them so the previous topic is reused. */
function looksLikeFollowUp(question: string): boolean {
  const tokens: string[] = question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const content = tokens.filter((token) => token.length > 2 && !FILLER_WORDS.has(token));
  if (content.length === 0) return true;
  return (
    content.length <= 3 &&
    tokens.length <= 14 &&
    (REWRITE_REQUEST.test(question) || PRONOUN_REFERENCE.test(question))
  );
}

/** The model is told to cite by number only; remove any "(Unit 3)" it writes into the prose anyway. */
function stripUnitMentions(answer: string): string {
  return answer
    .replace(/\s*\(\s*(?:units?|unit_id)\s*:?\s*\d+(?:\s*(?:,|and|&|-|to)\s*(?:units?\s*)?\d+)*\s*\)/gi, "")
    .replace(/\s*\[\s*(?:units?\s*)?\d+(?:\s*,\s*\d+)*\s*\]/gi, "")
    .replace(/【\s*\d+(?:\s*[,，、]\s*\d+)*\s*】/g, "")
    .replace(/([.!?])\s*\((?:source|citation|ref(?:erence)?)\s*\d+(?:\s*[,–-]\s*\d+)*\)(?=\s|$)/gi, "$1")
    .replace(/([.!?])\s*[⁰¹²³⁴⁵⁶⁷⁸⁹]+(?=\s|$)/g, "$1")
    .replace(/\b(?:as (?:shown|stated|mentioned) in )?units?\s*\d+(?:\s*(?:,|and|&)\s*(?:units?\s*)?\d+)*/gi, "the material")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function contextFor(units: GroundedUnit[]): string {
  return units
    .map((unit, position) => {
      const sourceLocation = JSON.stringify(unit.locator);
      return [
        `UNIT_ID: ${position + 1}`,
        `SOURCE: ${unit.sourceTitle} (${unit.sourceType})`,
        `LOCATOR: ${sourceLocation}`,
        `TEXT: ${unit.text.slice(0, 5_000)}`,
        unit.figureCaption ? `CAPTION: ${unit.figureCaption.slice(0, 1_000)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n---\n\n");
}

/* ------------------------------------------------------------------ friendly chat layer
 * Greetings, thanks and "what can you do?" are not course questions, so they get a warm reply instead
 * of a "not covered" warning. Replies that start with CHAT_TAG are rendered as plain friendly messages,
 * and lines starting with TRY_TAG become tappable suggestion chips in the web app.
 */
const CHAT_TAG = "<!--chat-->";
const TRY_TAG = "<!--try-->";

/** Removes the display tags so the model never sees them in the conversation history. */
function stripTags(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.startsWith(TRY_TAG))
    .join("\n")
    .replace(CHAT_TAG, "")
    .replaceAll("<!--cx-verified-->", "")
    .trim();
}

type SmallTalk = "greeting" | "wellbeing" | "thanks" | "bye" | "about";

function smallTalkKind(question: string): SmallTalk | null {
  const text = question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.length > 60 || text.split(" ").length > 8) return null;
  const greet =
    "(?:hi+|hello+|hey+|hiya|heya|yo|hola|namaste|namaskar|sup|gm|good (?:morning|afternoon|evening))";
  const addressee = "(?: (?:there|tutor|citexa|buddy|friend|bro|sir|mam|guys|all))?";
  const checkIn =
    "(?:how are (?:you|u)|how r u|how's it going|hows it going|what's up|whats up|wassup|kaise ho|kya haal hai)";
  if (new RegExp(`^${greet}${addressee}(?: ${checkIn})?$`).test(text)) return "greeting";
  if (new RegExp(`^${checkIn}$`).test(text)) return "wellbeing";
  if (
    /^(?:thanks?|thank you|thank u|thx|ty|shukriya|dhanyavad|great|awesome|nice|cool|perfect|good|wow|ok|okay|got it|understood|makes sense|i understand|i get it)(?: (?:tutor|citexa|a lot|so much|you|bro))*$/.test(
      text,
    )
  )
    return "thanks";
  if (/^(?:bye|goodbye|good bye|see you|see ya|cya|tata|alvida|good night|gn)(?: (?:tutor|citexa|later|soon))?$/.test(text))
    return "bye";
  if (
    /^(?:who are you|what are you|what is your name|what's your name|whats your name|what can you do|how can you help(?: me)?|how do you work|how does this work|help|help me|what should i ask|what can i ask(?: you)?|how to use this|are you (?:a )?(?:bot|ai|robot|human))$/.test(
      text,
    )
  )
    return "about";
  return null;
}

type CourseSnapshot = { name: string; readyTitles: string[]; sourceCount: number; busy: boolean; topics: string[] };

async function courseSnapshot(courseId: string, ownerId: string): Promise<CourseSnapshot> {
  const [course, sources, topicRows] = await Promise.all([
    findOwnedCourse(courseId, ownerId),
    db
      .select({ title: sourcesTable.title, status: sourcesTable.status })
      .from(sourcesTable)
      .where(and(eq(sourcesTable.courseId, courseId), eq(sourcesTable.ownerId, ownerId))),
    db
      .select({ name: topicsTable.name })
      .from(topicsTable)
      .innerJoin(conceptsTable, eq(conceptsTable.topicId, topicsTable.id))
      .innerJoin(unitConceptsTable, eq(unitConceptsTable.conceptId, conceptsTable.id))
      .innerJoin(unitsTable, eq(unitsTable.id, unitConceptsTable.unitId))
      .innerJoin(sourcesTable, eq(sourcesTable.id, unitsTable.sourceId))
      .where(and(
        eq(topicsTable.courseId, courseId),
        eq(sourcesTable.ownerId, ownerId),
        eq(sourcesTable.status, "ready"),
      ))
      .limit(240),
  ]);
  const topics = [...new Set(topicRows.map((row) => row.name.trim()).filter((name) => name.length > 2))];
  return {
    name: course?.name ?? "your course",
    readyTitles: sources.filter((row) => row.status === "ready").map((row) => row.title),
    sourceCount: sources.length,
    busy: sources.some((row) => row.status === "queued" || row.status === "processing"),
    topics: [...new Set(topics)],
  };
}

function pickSpread<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  return Array.from({ length: count }, (_, index) => items[Math.floor((index * items.length) / count)]!);
}

function suggestionsFor(snapshot: CourseSnapshot, language: TutorLanguage = "en"): string[] {
  const fromTopics = pickSpread(snapshot.topics, 3).map((topic) => LANGUAGE_COPY[language].explain(topic));
  if (fromTopics.length > 0) return fromTopics;
  if (snapshot.readyTitles.length > 0) {
    const title = snapshot.readyTitles[0];
    const summaries: Record<TutorLanguage, string> = {
      en: `Summarise ${title}`, hi: `${title} का सारांश बताइए`, hinglish: `${title} ka summary batao`,
      ta: `${title} சுருக்கமாகச் சொல்லுங்கள்`, te: `${title} సారాంశం చెప్పండి`,
      bn: `${title}-এর সারাংশ বলুন`, mr: `${title} चा सारांश सांगा`,
    };
    return [summaries[language]];
  }
  return [];
}

function withSuggestions(text: string, suggestions: string[]): string {
  return [text, ...suggestions.map((item) => `${TRY_TAG}${item}`)].join("\n");
}

function templateSmallTalk(kind: SmallTalk, snapshot: CourseSnapshot, language: TutorLanguage): string {
  const readyLineByLanguage: Record<TutorLanguage, string> = {
    en: snapshot.readyTitles.length ? `I can explain your material and show where it came from in ${snapshot.name}.` : snapshot.busy ? "Your material is still processing; ask me once it is ready." : "Add a PDF or slides and I can answer from them.",
    hi: snapshot.readyTitles.length ? `${snapshot.name} की सामग्री समझाने और उसका पेज या स्लाइड दिखाने में मैं मदद कर सकता हूँ।` : snapshot.busy ? "आपकी सामग्री अभी तैयार हो रही है; तैयार होने पर मुझसे पूछें।" : "PDF या स्लाइड जोड़ें, फिर मैं उनसे उत्तर दे सकूँगा।",
    hinglish: snapshot.readyTitles.length ? `Main ${snapshot.name} ke material se samjha sakta hoon aur exact page ya slide bhi dikha sakta hoon.` : snapshot.busy ? "Aapka material abhi process ho raha hai; Ready hone par poochhein." : "PDF ya slides add karein, phir main unse answer kar paunga.",
    ta: snapshot.readyTitles.length ? `${snapshot.name} பாடப் பொருளை விளக்கி, அது உள்ள பக்கம் அல்லது ஸ்லைடையும் காட்ட முடியும்.` : snapshot.busy ? "உங்கள் பாடப் பொருள் இன்னும் செயலாக்கப்படுகிறது; தயாரானதும் கேளுங்கள்." : "PDF அல்லது ஸ்லைடுகளைச் சேர்த்தால் அவற்றிலிருந்து பதிலளிக்க முடியும்.",
    te: snapshot.readyTitles.length ? `${snapshot.name} మెటీరియల్‌ను వివరించి, సంబంధిత పేజీ లేదా స్లైడ్‌ను చూపగలను.` : snapshot.busy ? "మీ మెటీరియల్ ఇంకా ప్రాసెస్ అవుతోంది; సిద్ధమైన తర్వాత అడగండి." : "PDF లేదా స్లైడ్స్‌ను జోడిస్తే వాటి నుంచి సమాధానం ఇస్తాను.",
    bn: snapshot.readyTitles.length ? `${snapshot.name}-এর উপকরণ বুঝিয়ে দিতে এবং সঠিক পৃষ্ঠা বা স্লাইড দেখাতে পারি।` : snapshot.busy ? "আপনার উপকরণ এখনো প্রক্রিয়াধীন; প্রস্তুত হলে জিজ্ঞাসা করুন।" : "PDF বা স্লাইড যোগ করলে সেগুলো থেকে উত্তর দিতে পারি।",
    mr: snapshot.readyTitles.length ? `${snapshot.name} मधील सामग्री समजावून सांगून संबंधित पान किंवा स्लाइड दाखवू शकतो.` : snapshot.busy ? "तुमची सामग्री अजून प्रक्रिया होत आहे; तयार झाल्यावर विचारा." : "PDF किंवा स्लाइड्स जोडा, मग त्यातून उत्तर देता येईल.",
  };
  const readyLine = readyLineByLanguage[language];
  if (language !== "en") {
    const localized: Record<Exclude<TutorLanguage, "en">, Record<SmallTalk, string>> = {
      hi: { greeting: "नमस्ते! मैं Citexa का आपका अध्ययन सहायक हूँ।", wellbeing: "मैं ठीक हूँ, पूछने के लिए धन्यवाद!", thanks: "आपका स्वागत है! क्या किसी विषय को और समझें?", bye: "फिर मिलेंगे! पढ़ाई के लिए शुभकामनाएँ।", about: "मैं Citexa हूँ। मैं आपकी सामग्री से उत्तर देता हूँ, स्रोत दिखाता हूँ और अभ्यास में मदद करता हूँ।" },
      hinglish: { greeting: "Namaste! Main Citexa ka aapka study tutor hoon.", wellbeing: "Main theek hoon, poochhne ke liye shukriya!", thanks: "Aapka swagat hai! Kya kisi topic ko aur samjhein?", bye: "Phir milte hain! Padhai ke liye best wishes.", about: "Main Citexa hoon. Main aapke material se answer, source reference aur practice mein help karta hoon." },
      ta: { greeting: "வணக்கம்! நான் Citexa-வின் உங்கள் படிப்பு உதவியாளர்.", wellbeing: "நன்றாக இருக்கிறேன், கேட்டதற்கு நன்றி!", thanks: "நன்றி! வேறு ஏதாவது தலைப்பை விளக்கட்டுமா?", bye: "மீண்டும் சந்திப்போம்! படிப்புக்கு வாழ்த்துகள்.", about: "நான் Citexa. உங்கள் பாடப் பொருளிலிருந்து பதிலளித்து, ஆதாரத்தைக் காட்டி, பயிற்சியில் உதவுகிறேன்." },
      te: { greeting: "నమస్కారం! నేను Citexa మీ స్టడీ ట్యూటర్‌ను.", wellbeing: "బాగున్నాను, అడిగినందుకు ధన్యవాదాలు!", thanks: "స్వాగతం! ఇంకేదైనా అంశాన్ని వివరించనా?", bye: "మళ్లీ కలుద్దాం! చదువులో శుభాకాంక్షలు.", about: "నేను Citexa. మీ మెటీరియల్‌ ఆధారంగా సమాధానాలు, మూలాలు, ప్రాక్టీస్‌లో సహాయం చేస్తాను." },
      bn: { greeting: "নমস্কার! আমি Citexa, আপনার পড়াশোনার সহায়ক।", wellbeing: "ভালো আছি, জিজ্ঞাসা করার জন্য ধন্যবাদ!", thanks: "স্বাগতম! আর কোনো বিষয় বুঝিয়ে বলব?", bye: "আবার দেখা হবে! পড়াশোনার জন্য শুভকামনা।", about: "আমি Citexa। আপনার উপকরণ থেকে উত্তর, সূত্র এবং অনুশীলনে সাহায্য করি।" },
      mr: { greeting: "नमस्कार! मी Citexa, तुमचा अभ्यास सहायक आहे.", wellbeing: "मी छान आहे, विचारल्याबद्दल धन्यवाद!", thanks: "स्वागत आहे! आणखी एखादा विषय समजावून सांगू का?", bye: "पुन्हा भेटू! अभ्यासासाठी शुभेच्छा.", about: "मी Citexa. तुमच्या सामग्रीतून उत्तर, संदर्भ आणि सरावात मदत करतो." },
    };
    return `${localized[language][kind]} ${readyLine}`;
  }
  switch (kind) {
    case "greeting": return `Hi! 👋 I'm your Citexa tutor. ${readyLine}`;
    case "wellbeing": return `I'm doing great, thanks for asking! 😊 ${readyLine}`;
    case "thanks": return "You're welcome! Want me to explain something else, give an example, or go deeper on a topic?";
    case "bye": return "Bye for now! Come back whenever you want to revise. Good luck with your studies. 🌟";
    default: return `I'm Citexa, your study tutor. I answer from your course material, show source locations, and can quiz you. ${readyLine}`;
  }
}

async function smallTalkReply(kind: SmallTalk, rawQuestion: string, snapshot: CourseSnapshot, language: TutorLanguage): Promise<string> {
  const suggestions = kind === "bye" || kind === "thanks" ? [] : suggestionsFor(snapshot, language);
  let text = "";
  try {
    const isGptOss = /gpt-oss/i.test(modelConfig.tutor);
    const response = await withRetry(
      () =>
        openai().chat.completions.create({
          model: modelConfig.tutor,
          max_completion_tokens: isGptOss ? 500 : 200,
          temperature: 0.7,
          ...((isGptOss ? { reasoning_effort: "low" } : {}) as Record<string, unknown>),
          messages: [
            {
              role: "system",
              content: [
                "You are Citexa, a warm, encouraging study tutor chatting with a student.",
                "Reply in one to three short, friendly sentences. Use at most one emoji. No headings or lists.",
                answerLanguageRule(language),
                "This message is small talk, not a course question: do not teach anything and do not invent facts about their course.",
                "You may mention that you explain their own material and show the exact page or video moment, and that you can quiz them.",
                snapshot.readyTitles.length > 0
                  ? `Their course is "${snapshot.name}" with ready sources: ${snapshot.readyTitles.slice(0, 5).join("; ")}.`
                  : snapshot.busy
                    ? `Their course is "${snapshot.name}" and its sources are still processing.`
                    : `Their course is "${snapshot.name}" and has no ready sources yet; gently invite them to add a PDF, slides or a video.`,
                suggestions.length > 0 ? "End by inviting them to try one of the suggested questions (they appear below your message)." : "",
              ]
                .filter(Boolean)
                .join("\n"),
            },
            { role: "user", content: rawQuestion },
          ],
        }),
      2,
    );
    text = (response.choices[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  } catch (error) {
    logger.warn({ error }, "Small-talk reply fell back to the built-in message");
  }
  if (text.length < 2 || text.length > 700) text = templateSmallTalk(kind, snapshot, language);
  return `${CHAT_TAG}${withSuggestions(text, suggestions)}`;
}

/** A kind "I couldn't find that" message that points to what the course does cover. */
async function notCoveredReply(courseId: string, ownerId: string, gap?: string, language: TutorLanguage = "en"): Promise<string> {
  let snapshot: CourseSnapshot | null = null;
  try {
    snapshot = await courseSnapshot(courseId, ownerId);
  } catch (error) {
    logger.warn({ error }, "Could not load course overview for the not-covered reply");
  }
  const copy = LANGUAGE_COPY[language];
  const lead = language === "en" && gap && gap.length > 8 && gap.length < 260 ? gap : copy.notCovered;
  const topics = snapshot ? pickSpread(snapshot.topics, 4) : [];
  const hint =
    topics.length > 0
      ? copy.hasTopics(topics.join(", "))
      : copy.noTopics;
  return withSuggestions(`${lead}\n\n${hint}`, snapshot ? suggestionsFor(snapshot, language) : []);
}

function notReadyMessage(kind: "none" | "processing" | "failed", language: TutorLanguage): string {
  const copy = LANGUAGE_COPY[language];
  return kind === "none" ? copy.noSources : kind === "processing" ? copy.processing : copy.failedSources;
}

function sourceExcerptFallback(units: GroundedUnit[], language: TutorLanguage): string {
  const copy = LANGUAGE_COPY[language];
  const seen = new Set<string>();
  const sentences = units.slice(0, 4).flatMap((unit) => {
  const text = [unit.text, unit.figureCaption].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return text.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim());
  }).filter((sentence) => {
    if (sentence.length < 20) return false;
    const key = sentence.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const mainIdea = sentences.slice(0, 2).join(" ").slice(0, 1_200);
  const details = sentences.slice(2, 10).map((sentence) => `- ${sentence.slice(0, 900)}`);
  return [
    copy.busy,
    `**${copy.excerptIntro}**\n\n${mainIdea || sentences[0] || "Open a source link below to read the relevant course material."}`,
    details.length ? `**${copy.detailIntro}**\n\n${details.join("\n\n")}` : "",
    `**${copy.reviewTip}**\n\n${copy.reviewHint}`,
  ].filter(Boolean).join("\n\n");
}

router.get(
  "/courses/:courseId/conversations",
  async (req: Request, res: Response) => {
    const ownerId = studygraphOwnerId(res);
    const courseId = studygraphPathParam(req, "courseId");
    if (!validStudygraphId(courseId)) {
      res.status(400).json({ error: "Invalid course id." });
      return;
    }
    const course = await findOwnedCourse(courseId, ownerId);
    if (!course) {
      res.status(404).json({ error: "Course not found." });
      return;
    }
    const conversations = await db
      .select()
      .from(conversationsTable)
      .where(
        and(
          eq(conversationsTable.courseId, courseId),
          eq(conversationsTable.ownerId, ownerId),
        ),
      )
      .orderBy(desc(conversationsTable.updatedAt))
      .limit(40);
    const counts =
      conversations.length > 0
        ? await db
            .select({
              conversationId: conversationMessagesTable.conversationId,
              messageCount: sql<number>`count(*)::int`,
            })
            .from(conversationMessagesTable)
            .where(
              inArray(
                conversationMessagesTable.conversationId,
                conversations.map((item) => item.id),
              ),
            )
            .groupBy(conversationMessagesTable.conversationId)
        : [];
    const countById = new Map(
      counts.map((item) => [item.conversationId, Number(item.messageCount)]),
    );
    res.json(
      conversations.map((item) => ({
        id: item.id,
        courseId: item.courseId,
        title: item.title,
        messageCount: countById.get(item.id) ?? 0,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
    );
  },
);

router.post(
  "/courses/:courseId/conversations",
  async (req: Request, res: Response) => {
    const ownerId = studygraphOwnerId(res);
    const courseId = studygraphPathParam(req, "courseId");
    if (!validStudygraphId(courseId)) {
      res.status(400).json({ error: "Invalid course id." });
      return;
    }
    const input = CreateStudyConversationBody.safeParse(req.body ?? {});
    if (!input.success) {
      res.status(400).json({ error: "Conversation details are invalid." });
      return;
    }
    const course = await findOwnedCourse(courseId, ownerId);
    if (!course) {
      res.status(404).json({ error: "Course not found." });
      return;
    }
    const [conversation] = await db
      .insert(conversationsTable)
      .values({
        courseId,
        ownerId,
        title: input.data.title?.trim() || "New study session",
      })
      .returning();
    res.status(201).json({
      id: conversation.id,
      courseId: conversation.courseId,
      title: conversation.title,
      messageCount: 0,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    });
  },
);

router.get(
  "/conversations/:conversationId/messages",
  async (req: Request, res: Response) => {
    const ownerId = studygraphOwnerId(res);
    const conversationId = studygraphPathParam(req, "conversationId");
    if (!validStudygraphId(conversationId)) {
      res.status(400).json({ error: "Invalid conversation id." });
      return;
    }
    const conversation = await findOwnedConversation(conversationId, ownerId);
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found." });
      return;
    }
    const messages = await db
      .select()
      .from(conversationMessagesTable)
      .where(eq(conversationMessagesTable.conversationId, conversationId))
      .orderBy(desc(conversationMessagesTable.createdAt))
      .limit(120);
    res.json(messages.reverse().map(messageDto));
  },
);

router.post(
  "/conversations/:conversationId/messages",
  async (req: Request, res: Response) => {
    const ownerId = studygraphOwnerId(res);
    const conversationId = studygraphPathParam(req, "conversationId");
    if (!validStudygraphId(conversationId)) {
      res.status(400).json({ error: "Invalid conversation id." });
      return;
    }
    const input = SendConversationMessageBody.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "Enter a question between 2 and 6,000 characters." });
      return;
    }
    const conversation = await findOwnedConversation(conversationId, ownerId);
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found." });
      return;
    }

    const language = requestedLanguage(input.data.content);

    // Greetings, thanks and "what can you do?" get a friendly reply instead of a "not covered" warning.
    const talk = smallTalkKind(stripNote(input.data.content));
    if (talk) {
      let snapshot: CourseSnapshot = { name: "your course", readyTitles: [], sourceCount: 0, busy: false, topics: [] };
      try {
        snapshot = await courseSnapshot(conversation.courseId, ownerId);
      } catch (error) {
        logger.warn({ error }, "Could not load course overview for small talk");
      }
      const reply = await smallTalkReply(talk, input.data.content.trim(), snapshot, language);
      const saved = await saveTurn(conversationId, ownerId, conversation.title, input.data.content.trim(), reply, []);
      res.json({
        userMessage: messageDto(saved.userMessage),
        assistantMessage: messageDto(saved.assistantMessage),
        supportStatus: "supported",
      });
      return;
    }

    // Edge case: nothing is ready to search yet. Say so plainly instead of "not covered".
    const sourceStates = await db
      .select({ status: sourcesTable.status })
      .from(sourcesTable)
      .where(and(eq(sourcesTable.courseId, conversation.courseId), eq(sourcesTable.ownerId, ownerId)));
    if (!sourceStates.some((row) => row.status === "ready")) {
      const busy = sourceStates.some((row) => row.status === "queued" || row.status === "processing");
      const message = notReadyMessage(sourceStates.length === 0 ? "none" : busy ? "processing" : "failed", language);
      const saved = await saveTurn(
        conversationId,
        ownerId,
        conversation.title,
        input.data.content.trim(),
        message,
        [],
      );
      res.json({
        userMessage: messageDto(saved.userMessage),
        assistantMessage: messageDto(saved.assistantMessage),
        supportStatus: "insufficient_context",
      });
      return;
    }

    const history = await db
      .select({
        role: conversationMessagesTable.role,
        content: conversationMessagesTable.content,
        citations: conversationMessagesTable.citations,
      })
      .from(conversationMessagesTable)
      .where(eq(conversationMessagesTable.conversationId, conversationId))
      .orderBy(desc(conversationMessagesTable.createdAt))
      .limit(12);

    // Follow-ups ("more in simple words", "why?") are searched together with the previous question,
    // and the units cited in the previous answer are kept in context so the chat stays linked.
    const currentQuestion = stripNote(input.data.content);
    const followUp = looksLikeFollowUp(currentQuestion);
    const previousQuestions = history
      .filter((item) => item.role === "user")
      .map((item) => stripNote(item.content))
      .slice(0, 2);
    const lastAnswer = stripTags(
      history.find((item) => item.role === "assistant" && item.citations.length > 0)?.content ?? "",
    ).slice(0, 300);
    const searchText =
      followUp && previousQuestions.length > 0
        ? `${currentQuestion}\n${previousQuestions.join("\n")}\n${lastAnswer}`
        : currentQuestion;
    const previousCitedIds = followUp
      ? [
          ...new Set(
            (history.find((item) => item.role === "assistant" && item.citations.length > 0)?.citations ?? []).map(
              (citation) => citation.unitId,
            ),
          ),
        ]
      : [];

    let units: GroundedUnit[];
    try {
      const rewrite = await englishSearchRewrite(searchText, language);
      const searchQueries = [...new Set([searchText, rewrite].filter(Boolean))];
      const [carried, foundSets] = await Promise.all([
        loadUnitsByIds(conversation.courseId, ownerId, previousCitedIds),
        Promise.all(searchQueries.map((query) => retrieveRelevantUnits(conversation.courseId, ownerId, query))),
      ]);
      const found = foundSets.flat();
      const seen = new Set<string>();
      units = [...carried, ...found].filter((unit) => !seen.has(unit.id) && seen.add(unit.id)).slice(0, 10);
    } catch (error) {
      logger.error({ error, conversationId }, "Tutor retrieval failed");
      res.status(503).json({
        error: "StudyGraph could not search course material. Try again in a moment.",
      });
      return;
    }

    logger.info({ retrieved: units.length }, "Tutor retrieval");
    if (units.length === 0) {
      const saved = await saveTurn(
        conversationId,
        ownerId,
        conversation.title,
        input.data.content.trim(),
        await notCoveredReply(conversation.courseId, ownerId, undefined, language),
        [],
      );
      res.json({
        userMessage: messageDto(saved.userMessage),
        assistantMessage: messageDto(saved.assistantMessage),
        supportStatus: "insufficient_context",
      });
      return;
    }

    try {
      const tutorMessages = [
        {
          role: "system" as const,
          content: [
            "You are Citexa, a friendly tutor. Teach the student using their course material, in clear, everyday language.",
            "ACCURACY RULES",
            "- Use only the supplied course units. Never add outside facts or guess. Keep formulas, numbers, names, and code correct, but explain the surrounding ideas in your own simple words instead of copying dense paragraphs.",
            "- Before writing, check every sentence against the units. If a detail is not in the units, leave it out.",
            "- If the units cover only part of the question, answer that part and say plainly what the material does not cover.",
            "- If the units do not support any reliable answer, set answerable to false and explain the gap in one sentence.",
            "STYLE RULES",
            "- Write all student-facing prose in the chosen language. Use common words and short, natural sentences. Do not use difficult grammar or unexplained technical terms.",
            "- Start with one clear sentence that directly answers the question. Then explain the idea in 2–5 short steps or bullets. Define any necessary technical word in simple language.",
            "- Add a small, easy example when the course material supports one. Include the details needed to understand the answer, but leave out unrelated side topics.",
            "- Do not number or label sentences, add inline numeric reference markers, or write verification/status messages. Keep a natural, friendly conversation; citations are attached separately by the app.",
            "- If the student asks to simplify, shorten, explain again, give an example, or asks 'more', re-explain your previous answer from the same material in simpler words. Do not refuse such requests.",
            answerLanguageRule(language),
            "CITATION RULES",
            "- List the supporting UNIT_ID numbers (for example [1,3]) only in citationUnitIds.",
            "- Never write 'Unit 1', 'UNIT_ID' or any unit number inside the answer text.",
            "- For broad questions (main idea, summary, overview), summarize what the supplied units cover.",
            "Return only JSON with this shape: {\"answerable\":boolean,\"answer\":string,\"citationUnitIds\":string[]}.",
            `COURSE MATERIAL:\n${contextFor(units)}`,
          ].join("\n"),
        },
        ...[...history].reverse().map((item) => ({
          role: item.role as "user" | "assistant",
          content: item.role === "assistant" ? stripTags(item.content) : item.content,
        })),
        { role: "user" as const, content: input.data.content.trim() },
      ];
      const createAnswer = (model: string) => openai().chat.completions.create({
        model,
        max_completion_tokens: 2_500,
        response_format: { type: "json_object" },
        ...((/gpt-oss/i.test(model) ? { reasoning_effort: "medium" } : {}) as Record<string, unknown>),
        messages: tutorMessages,
      });
      let response: Awaited<ReturnType<typeof createAnswer>>;
      try {
        response = await withRetry(() => createAnswer(modelConfig.tutor));
      } catch (primaryError) {
        const backupModel = modelConfig.validator !== modelConfig.tutor ? modelConfig.validator : "llama-3.1-8b-instant";
        if (backupModel === modelConfig.tutor) throw primaryError;
        logger.info({ primaryModel: modelConfig.tutor, backupModel }, "Retrying tutor answer with the backup model");
        response = await withRetry(() => createAnswer(backupModel), 1);
      }
      const raw = response.choices[0]?.message?.content;
      const parsed = raw ? parseTutorResult(raw) : null;
      if (!parsed) throw new Error("Tutor returned an invalid structured answer.");

      const unitById = new Map(units.map((unit) => [unit.id, unit]));
      const resolveUnit = (value: string): GroundedUnit | undefined => {
        const trimmed = value.replace(/[^0-9a-f-]/gi, "");
        if (/^\d+$/.test(trimmed)) return units[Number(trimmed) - 1];
        return unitById.get(value) ?? unitById.get(trimmed);
      };
      const citations = [...new Set(parsed.citationUnitIds)]
        .map(resolveUnit)
        .filter((unit): unit is GroundedUnit => Boolean(unit))
        .slice(0, 5)
        .map(citationFor);
      // If the model answered from the supplied units but mangled the unit numbers, cite the
      // supplied units that actually share wording with the answer (never units it wasn't given).
      if (parsed.answerable && parsed.answer.length > 0 && citations.length === 0) {
        const words = new Set(
          (parsed.answer.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).slice(0, 400),
        );
        const scored = units
          .map((unit) => {
            const unitWords = new Set(unit.text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);
            let overlap = 0;
            for (const word of words) if (unitWords.has(word)) overlap += 1;
            return { unit, overlap };
          })
          .filter((item) => item.overlap >= 4)
          .sort((a, b) => b.overlap - a.overlap)
          .slice(0, 3);
        for (const item of scored) citations.push(citationFor(item.unit));
      }
      logger.info(
        {
          retrieved: units.length,
          answerable: parsed.answerable,
          modelCited: parsed.citationUnitIds.length,
          resolvedCitations: citations.length,
        },
        "Tutor answer",
      );
      const supported = parsed.answerable && parsed.answer.length > 0 && citations.length > 0;
      const assistantContent = supported
        ? stripUnitMentions(parsed.answer)
        : await notCoveredReply(
            conversation.courseId,
            ownerId,
            !parsed.answerable && parsed.answer ? stripUnitMentions(parsed.answer) : undefined,
            language,
          );
      const saved = await saveTurn(
        conversationId,
        ownerId,
        conversation.title,
        input.data.content.trim(),
        assistantContent,
        supported ? citations : [],
      );
      res.json({
        userMessage: messageDto(saved.userMessage),
        assistantMessage: messageDto(saved.assistantMessage),
        supportStatus: supported ? "supported" : "insufficient_context",
      });
    } catch (error) {
      logger.warn({ error, conversationId, retrieved: units.length }, "Tutor fell back to cited source excerpts");
      const citations = units.slice(0, 4).map(citationFor);
      const saved = await saveTurn(
        conversationId,
        ownerId,
        conversation.title,
        input.data.content.trim(),
        sourceExcerptFallback(units, language),
        citations,
      );
      res.json({
        userMessage: messageDto(saved.userMessage),
        assistantMessage: messageDto(saved.assistantMessage),
        supportStatus: "source_fallback",
      });
    }
  },
);

/**
 * Progressive tutor mode. Each sentence is checked by the independently configured
 * validator before it is emitted, and unsupported sentences are never shown or saved.
 * The original JSON message endpoint remains available for older clients.
 */
router.post("/conversations/:conversationId/messages/stream", async (req: Request, res: Response) => {
  const ownerId = studygraphOwnerId(res);
  const conversationId = studygraphPathParam(req, "conversationId");
  if (!validStudygraphId(conversationId)) {
    res.status(400).json({ error: "Invalid conversation id." });
    return;
  }
  const input = SendConversationMessageBody.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ error: "Enter a question between 2 and 6,000 characters." });
    return;
  }
  const conversation = await findOwnedConversation(conversationId, ownerId);
  if (!conversation) {
    res.status(404).json({ error: "Conversation not found." });
    return;
  }

  const language = requestedLanguage(input.data.content);

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const sendEvent = (event: string, data: unknown) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const question = input.data.content.trim();
    const finishWithoutSources = async (reply: string, supportStatus: string) => {
      sendEvent("sentence", { text: reply, verified: false });
      const saved = await saveTurn(conversationId, ownerId, conversation.title, question, reply, []);
      sendEvent("done", {
        userMessage: messageDto(saved.userMessage),
        assistantMessage: messageDto(saved.assistantMessage),
        supportStatus,
      });
      res.end();
    };

    const talk = smallTalkKind(stripNote(question));
    if (talk) {
      let snapshot: CourseSnapshot = { name: "your course", readyTitles: [], sourceCount: 0, busy: false, topics: [] };
      try { snapshot = await courseSnapshot(conversation.courseId, ownerId); }
      catch (error) { logger.warn({ error }, "Could not load course overview for streamed small talk"); }
      await finishWithoutSources(await smallTalkReply(talk, question, snapshot, language), "supported");
      return;
    }

    const sourceStates = await db.select({ status: sourcesTable.status }).from(sourcesTable)
      .where(and(eq(sourcesTable.courseId, conversation.courseId), eq(sourcesTable.ownerId, ownerId)));
    if (!sourceStates.some((row) => row.status === "ready")) {
      const busy = sourceStates.some((row) => row.status === "queued" || row.status === "processing");
      const reply = notReadyMessage(sourceStates.length === 0 ? "none" : busy ? "processing" : "failed", language);
      await finishWithoutSources(reply, "insufficient_context");
      return;
    }

    const history = await db.select({ role: conversationMessagesTable.role, content: conversationMessagesTable.content, citations: conversationMessagesTable.citations })
      .from(conversationMessagesTable).where(eq(conversationMessagesTable.conversationId, conversationId))
      .orderBy(desc(conversationMessagesTable.createdAt)).limit(12);
    const cleanQuestion = stripNote(question);
    const followUp = looksLikeFollowUp(cleanQuestion);
    const previousQuestions = history.filter((item) => item.role === "user").map((item) => stripNote(item.content)).slice(0, 2);
    const lastAnswer = stripTags(history.find((item) => item.role === "assistant" && item.citations.length > 0)?.content ?? "").slice(0, 300);
    const searchText = followUp && previousQuestions.length > 0 ? `${cleanQuestion}\n${previousQuestions.join("\n")}\n${lastAnswer}` : cleanQuestion;
    const previousCitedIds = followUp ? [...new Set((history.find((item) => item.role === "assistant" && item.citations.length > 0)?.citations ?? []).map((item) => item.unitId))] : [];
    const rewrite = await englishSearchRewrite(searchText, language);
    const searchQueries = [...new Set([searchText, rewrite].filter(Boolean))];
    const [carried, found] = await Promise.all([
      loadUnitsByIds(conversation.courseId, ownerId, previousCitedIds),
      Promise.all(searchQueries.map((query) => retrieveRelevantUnits(conversation.courseId, ownerId, query))).then((sets) => sets.flat()),
    ]);
    const seen = new Set<string>();
    const units = [...carried, ...found].filter((unit) => !seen.has(unit.id) && seen.add(unit.id)).slice(0, 10);
    if (!units.length) {
      await finishWithoutSources(await notCoveredReply(conversation.courseId, ownerId, undefined, language), "insufficient_context");
      return;
    }

    sendEvent("status", { text: "Writing and checking each sentence against your sources…" });
    const sourceContext = contextFor(units);
    const historyContext = [...history].reverse().map((item) => ({
      role: item.role,
      content: item.role === "assistant" ? stripTags(item.content) : item.content,
    }));
    const stream = await withRetry(() => openai().chat.completions.create({
      model: modelConfig.tutor,
      stream: true,
      max_completion_tokens: 2000,
      ...((/gpt-oss/i.test(modelConfig.tutor) ? { reasoning_effort: "medium" } : {}) as Record<string, unknown>),
      messages: [
        { role: "system", content: [
          "You are Citexa, a patient tutor who explains only the student's supplied course material.",
          "Use only the supplied course units. Never add outside facts, guess, or invent formulas. If nothing in the material supports an answer, say that briefly.",
          "Use short, beginner-friendly sentences. Use Markdown and LaTeX where helpful. Do not add inline numeric references or number prose sentences.",
          answerLanguageRule(language),
          "Do not include a citation list; the app attaches source evidence separately.",
          `COURSE MATERIAL:\n${sourceContext}`,
        ].join("\n") },
        ...historyContext,
        { role: "user" as const, content: question },
      ],
    }));

    let buffer = "";
    let persisted = "";
    let sentenceCount = 0;
    let withheldCount = 0;
    const citedUnits = new Map<string, GroundedUnit>();
    const verifyAndSend = async (candidate: string) => {
      const text = stripUnitMentions(candidate.trim());
      if (!text || sentenceCount >= 18) return;
      const verification = await withRetry(() => openai().chat.completions.create({
        model: modelConfig.validator,
        response_format: { type: "json_object" },
        max_completion_tokens: 350,
        messages: [
          { role: "system", content: "Independently verify one claim/sentence strictly against the supplied source units. Mark supported only if the source directly entails the complete sentence. If it contains an unsupported detail, set supported=false. Return JSON {\"supported\":boolean,\"unitIndexes\":[integer indexes from the context]}. Do not use outside knowledge." },
          { role: "user", content: `SENTENCE:\n${text}\n\nSOURCE UNITS:\n${sourceContext}` },
        ],
      }));
      let parsed: { supported?: boolean; unitIndexes?: unknown[] } = {};
      try { parsed = JSON.parse(verification.choices[0]?.message.content ?? "{}"); } catch { /* An unparseable check fails closed. */ }
      const selected = [...new Set((parsed.unitIndexes ?? []).flatMap((index) => typeof index === "number" && Number.isInteger(index) && index >= 1 && index <= units.length ? [index - 1] : []))]
        .map((index) => units[index]).filter((unit): unit is GroundedUnit => !!unit);
      if (parsed.supported !== true || !selected.length) {
        withheldCount += 1;
        sendEvent("withheld", { count: 1 });
        return;
      }
      sentenceCount += 1;
      for (const unit of selected) citedUnits.set(unit.id, unit);
      const emittedText = candidate;
      persisted += `${emittedText}<!--cx-verified-->`;
      sendEvent("sentence", { text: emittedText, verified: true });
    };

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (!delta) continue;
      buffer += delta;
      // Emit only complete sentences after the validator has confirmed them.
      let boundary = /(?<=[.!?])(?:["'”’)]*)\s+|\n{2,}/u.exec(buffer);
      while (boundary && sentenceCount < 18) {
        const end = boundary.index + boundary[0].length;
        const candidate = buffer.slice(0, end);
        buffer = buffer.slice(end);
        await verifyAndSend(candidate);
        boundary = /(?<=[.!?])(?:["'”’)]*)\s+|\n{2,}/u.exec(buffer);
      }
    }
    if (buffer.trim() && sentenceCount < 18) await verifyAndSend(buffer);
    if (sentenceCount === 0) {
      persisted = await notCoveredReply(conversation.courseId, ownerId, undefined, language);
      sendEvent("sentence", { text: persisted, verified: false });
    }
    const citations = [...citedUnits.values()].slice(0, 5).map(citationFor);
    const savedContent = `${persisted.trim()}${withheldCount ? `<!--cx-withheld:${withheldCount}-->` : ""}`;
    const saved = await saveTurn(conversationId, ownerId, conversation.title, question, savedContent, citations);
    sendEvent("done", {
      userMessage: messageDto(saved.userMessage),
      assistantMessage: messageDto(saved.assistantMessage),
      supportStatus: sentenceCount ? "supported" : "insufficient_context",
    });
    res.end();
  } catch (error) {
    logger.error({ error, conversationId }, "Streamed tutor response failed");
    sendEvent("error", { error: "Citexa couldn't complete that checked answer. Please try again." });
    res.end();
  }
});

router.delete("/conversations/:conversationId", async (req: Request, res: Response) => {
  const ownerId = studygraphOwnerId(res);
  const conversationId = studygraphPathParam(req, "conversationId");
  if (!validStudygraphId(conversationId)) {
    res.status(400).json({ error: "Invalid conversation id." });
    return;
  }
  const conversation = await findOwnedConversation(conversationId, ownerId);
  if (!conversation) {
    res.status(404).json({ error: "Conversation not found." });
    return;
  }
  // Messages are removed automatically (ON DELETE CASCADE).
  await db
    .delete(conversationsTable)
    .where(and(eq(conversationsTable.id, conversationId), eq(conversationsTable.ownerId, ownerId)));
  res.status(204).end();
});

export default router;

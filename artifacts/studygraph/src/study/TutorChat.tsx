import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getListConversationMessagesQueryKey, getListStudyConversationsQueryKey,
  getListSourcesQueryKey, getListCoursesQueryKey, getGetCourseSummaryQueryKey,
  useCreateStudyConversation, useListConversationMessages, useListStudyConversations,
  useSendConversationMessage, useListSources, useRegisterUploadedSource, useRequestUploadUrl,
} from '@workspace/api-client-react';
import type { SourceSourceType } from '@workspace/api-client-react';
import { TriangleAlert, Globe, History, ImagePlus, Mic, Paperclip, Plus, Send, Sparkles, Square, Trash2, Volume2, X } from 'lucide-react';
import { askOutsideKnowledge, extractPhotoQuestion, sendChatSignal, useAccountSettings, useCreateQuiz, useSubmitQuiz } from './api';
import { card, CitationChips, ErrorNote, ghostBtn, primaryBtn, Spinner } from './common';
import { MarkdownAnswer } from './MarkdownAnswer';
import type { Citation, GradedResult, Quiz } from './types';

const sameOrigin = { credentials: 'same-origin' as const };
type Lang = 'en' | 'en-IN' | 'hi' | 'hinglish' | 'ta' | 'te' | 'bn' | 'mr';
const LANG_NOTE: Record<Lang, string> = {
  en: '\n\n(Please answer in English only, even if earlier messages or the source material use another language. Keep every citation to the source material.)',
  'en-IN': '\n\n(Please answer in Indian English. Keep every citation to the source material.)',
  hi: '\n\n(Please answer in Hindi using Devanagari script. Keep every citation to the source material.)',
  hinglish: '\n\n(Please answer in Hinglish: Hindi written in Roman script, with English technical terms. Keep every citation to the source material.)',
  ta: '\n\n(Please answer in Tamil using Tamil script. Keep technical terms clear and preserve every citation to the source material.)',
  te: '\n\n(Please answer in Telugu using Telugu script. Keep technical terms clear and preserve every citation to the source material.)',
  bn: '\n\n(Please answer in Bengali using Bengali script. Keep technical terms clear and preserve every citation to the source material.)',
  mr: '\n\n(Please answer in Marathi using Devanagari script. Keep technical terms clear and preserve every citation to the source material.)',
};
const speechLang: Record<Lang, string> = { en: 'en-IN', 'en-IN': 'en-IN', hi: 'hi-IN', hinglish: 'en-IN', ta: 'ta-IN', te: 'te-IN', bn: 'bn-IN', mr: 'mr-IN' };
const NOT_COVERED_LABEL: Record<Lang, string> = {
  en: 'Not covered in your course material', 'en-IN': 'Not covered in your course material',
  hi: 'आपकी पाठ्य सामग्री में नहीं मिला', hinglish: 'Aapke course material mein nahi mila',
  ta: 'உங்கள் பாடப் பொருளில் இல்லை', te: 'మీ కోర్సు మెటీరియల్‌లో లేదు',
  bn: 'আপনার কোর্সের উপকরণে নেই', mr: 'तुमच्या अभ्याससामग्रीत नाही',
};
const GENERAL_EXPLANATION_LABEL: Record<Lang, string> = {
  en: 'Show a general explanation (not from your material)', 'en-IN': 'Show a general explanation (not from your material)',
  hi: 'सामान्य व्याख्या दिखाएँ (आपकी सामग्री से नहीं)', hinglish: 'General explanation dikhayein (aapke material se nahi)',
  ta: 'பொதுவான விளக்கத்தைக் காட்டு (உங்கள் பாடப் பொருளிலிருந்து அல்ல)',
  te: 'సాధారణ వివరణ చూపు (మీ మెటీరియల్‌ నుంచి కాదు)',
  bn: 'সাধারণ ব্যাখ্যা দেখান (আপনার উপকরণ থেকে নয়)', mr: 'सामान्य स्पष्टीकरण दाखवा (तुमच्या सामग्रीतून नाही)',
};
const PHOTO_QUESTION_MARKER = 'Please solve this question from my photo using my course material:';
const stripNote = (text: string) => text.replace(/\n\n\(Please answer in [\s\S]*\)\s*$/, '');

function stripSentenceCitationNumbers(text: string): string {
  return text
    .replace(/([.!?])\s*\[(?:\d+(?:\s*,\s*\d+)*)\](?=\s|$)/g, '$1')
    .replace(/\[(?:\d+(?:\s*,\s*\d+)*)\](?=[.!?](?:\s|$))/g, '')
    .replace(/【\s*\d+(?:\s*[,，、]\s*\d+)*\s*】/g, '')
    .replace(/([.!?])\s*\((?:source|citation|ref(?:erence)?)?\s*\d+(?:\s*[,–-]\s*\d+)*\)(?=\s|$)/gi, '$1')
    .replace(/([.!?])\s*[⁰¹²³⁴⁵⁶⁷⁸⁹]+(?=\s|$)/g, '$1');
}

// The server marks friendly replies (greetings, thanks, "what can you do?") with CHAT_TAG and suggestion
// lines with TRY_TAG. They are shown as a plain friendly message with tappable suggestion chips.
const CHAT_TAG = '<!--chat-->';
const TRY_TAG = '<!--try-->';
function parseAssistant(content: string): { isChat: boolean; text: string; tries: string[] } {
  const lines = content.split('\n');
  const cleanSuggestion = (text: string) => text.replace(/<!--[^>]*-->/g, '').replace(/\d+ unsupported sentences? (?:was|were) withheld after source checking\.?/gi, '').trim();
  const tries = lines.filter(l => l.startsWith(TRY_TAG)).map(l => cleanSuggestion(l.slice(TRY_TAG.length))).filter(Boolean);
  const raw = lines.filter(l => !l.startsWith(TRY_TAG)).join('\n')
    .replaceAll(CHAT_TAG, '')
    .replace(/<!--(?:cx-verified|cx-withheld:\d+)-->/gi, '')
    .replace(/verified against course sources/gi, '')
    .replace(/\d+ unsupported sentences? (?:was|were) withheld after source checking\.?/gi, '')
    .replace(/^\s*sources\s*$/gim, '')
    .replace(/^\s*\d+[.)]\s+/gm, '');
  return { isChat: content.startsWith(CHAT_TAG), text: stripSentenceCitationNumbers(raw.trim()), tries };
}
const FOLLOW_UPS = [
  { label: 'Explain simpler', prompt: 'Explain that again in simpler words' },
  { label: 'Give an example', prompt: 'Give me an example of that' },
  { label: 'Go deeper', prompt: 'Go into more detail on that' },
];
const STARTERS = [
  { label: 'Say hello 👋', prompt: 'Hello' },
  { label: 'What can you do?', prompt: 'What can you do?' },
];
const chipBtn = 'inline-flex max-w-full items-center rounded-full border border-[#d4d3c7] bg-[#f9f7ef] px-3 py-1.5 text-left text-xs font-medium text-[#365647] transition hover:border-[#25473c] hover:bg-white disabled:opacity-50';

function classifyAttachment(file: File): SourceSourceType | null {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf' || file.type === 'application/pdf') return 'pdf';
  if (ext === 'pptx' || file.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'pptx';
  if (file.type.startsWith('video/') || ['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv', 'mpeg', 'mpg', '3gp', 'wmv', 'flv', 'm2ts'].includes(ext)) return 'video';
  return null;
}

function putFile(file: File, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status}).`));
    xhr.onerror = () => reject(new Error('Upload connection failed. Check your connection and try again.'));
    xhr.onabort = () => reject(new Error('Upload was interrupted.'));
    xhr.send(file);
  });
}

async function photoAsDataUrl(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Could not prepare this photo.')), 'image/jpeg', 0.82));
    if (blob.size > 4_500_000) throw new Error('This photo is still too large. Please choose a smaller image.');
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read this photo.'));
      reader.onerror = () => reject(new Error('Could not read this photo.'));
      reader.readAsDataURL(blob);
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SpeechRecognitionCtor: any = typeof window !== 'undefined' ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : undefined;

function InlineCheck({ courseId, unitIds }: { courseId: string; unitIds: string[] }) {
  const create = useCreateQuiz(courseId);
  const submit = useSubmitQuiz(courseId);
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [choice, setChoice] = useState<number | null>(null);
  const [result, setResult] = useState<GradedResult | null>(null);
  const [delta, setDelta] = useState<{ before: number; after: number } | null>(null);
  const [error, setError] = useState('');

  async function start() {
    setError('');
    try { setQuiz(await create.mutateAsync({ mode: 'chat', count: 1, types: ['mcq'], unitIds })); }
    catch (e) { setError((e as Error).message); }
  }
  async function check() {
    if (!quiz || choice === null) return;
    setError('');
    try {
      const out = await submit.mutateAsync({ quizId: quiz.id, answers: [{ questionId: quiz.questions[0].id, answer: choice }] });
      setResult(out.results[0]);
      const m = out.mastery[0];
      if (m) setDelta({ before: m.before, after: m.after });
    } catch (e) { setError((e as Error).message); }
  }

  if (!quiz) return <div className="mt-3">
    <button onClick={start} disabled={create.isPending} className={ghostBtn}><Sparkles size={14} /> Quiz me on this</button>
    {create.isPending && <div className="mt-2"><Spinner label="Writing and verifying a question…" /></div>}
    {error && <div className="mt-2"><ErrorNote message={error} /></div>}
  </div>;

  const q = quiz.questions[0];
  return <div className="mt-3 rounded-xl border border-[#d9d5c6] bg-[#f6f3e8] p-4">
    <div className="font-mono-ui text-[10px] uppercase tracking-[.14em] text-[#a67d4d]">Check your understanding</div>
    <p className="mt-1 text-sm font-medium text-[#25473c]">{q.prompt}</p>
    <div className="mt-3 space-y-2">
      {q.options?.map((option, index) => {
        const picked = choice === index;
        const showCorrect = result && result.correctAnswer === option;
        return <button key={option} disabled={!!result} onClick={() => setChoice(index)}
          className={`block w-full rounded-lg border px-3 py-2 text-left text-sm transition ${showCorrect ? 'border-[#4f8a6a] bg-[#e7f1ea]' : picked ? 'border-[#25473c] bg-white' : 'border-[#dedbd0] bg-[#fbfaf5] hover:bg-white'}`}>
          <span className="font-mono-ui mr-2 text-xs text-[#a67d4d]">{String.fromCharCode(65 + index)}</span>{option}
        </button>;
      })}
    </div>
    {!result && <button onClick={check} disabled={choice === null || submit.isPending} className={`${primaryBtn} mt-3`}>{submit.isPending ? 'Checking…' : 'Check answer'}</button>}
    {result && <div className="mt-3 space-y-2 text-sm text-[#3d5348]">
      <p className={result.isCorrect ? 'font-semibold text-[#2f6b4a]' : 'font-semibold text-[#9a4d3f]'}>{result.isCorrect ? 'Correct' : 'Not quite'}</p>
      <p>{result.feedback}</p>
      {result.explanation && <p className="text-[#718075]">{result.explanation}</p>}
      {delta && <p className="font-mono-ui text-xs text-[#718075]">Mastery estimate {Math.round(delta.before * 100)}% → {Math.round(delta.after * 100)}%</p>}
      <CitationChips citations={result.citations} compact />
    </div>}
    {error && <div className="mt-2"><ErrorNote message={error} /></div>}
  </div>;
}

export function TutorChat({ courseId }: { courseId: string }) {
  const qc = useQueryClient();
  // AppFrame owns the authenticated Settings request; this observer only reads its cache.
  const accountSettings = useAccountSettings(false);
  const conversations = useListStudyConversations(courseId, { query: { queryKey: getListStudyConversationsQueryKey(courseId) }, request: sameOrigin });
  const courseSources = useListSources({ courseId }, { query: { queryKey: getListSourcesQueryKey({ courseId }) }, request: sameOrigin });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [startFresh, setStartFresh] = useState(false);
  const messagesQuery = useListConversationMessages(activeId ?? '', {
    query: { queryKey: getListConversationMessagesQueryKey(activeId ?? ''), enabled: !!activeId },
    request: sameOrigin,
  });
  const createConversation = useCreateStudyConversation({ request: sameOrigin });
  const send = useSendConversationMessage({ request: sameOrigin });
  const requestUpload = useRequestUploadUrl({ request: sameOrigin });
  const registerSource = useRegisterUploadedSource({ request: sameOrigin });
  const [text, setText] = useState('');
  const [attachment, setAttachment] = useState<File | null>(null);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [composerNotice, setComposerNotice] = useState('');
  const [attachmentPreview, setAttachmentPreview] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [lang, setLang] = useState<Lang>('en');
  const [listening, setListening] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [speechStatus, setSpeechStatus] = useState('');
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const manuallySelectedLanguage = useRef(false);
  useEffect(() => () => { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); }, []);
  useEffect(() => {
    if (!('speechSynthesis' in window)) return;
    const refreshVoices = () => setAvailableVoices(window.speechSynthesis.getVoices());
    refreshVoices();
    window.speechSynthesis.addEventListener?.('voiceschanged', refreshVoices);
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', refreshVoices);
  }, []);
  useEffect(() => {
    const saved = accountSettings.data?.language;
    if (!manuallySelectedLanguage.current && saved && ['en', 'en-IN', 'hi', 'ta', 'te', 'bn', 'mr'].includes(saved)) {
      setLang(saved as Lang);
    }
  }, [accountSettings.data?.language]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [outside, setOutside] = useState<Record<string, { answer?: string; loading?: boolean; error?: string }>>({});
  const [photoPreviews, setPhotoPreviews] = useState<Record<string, string>>({});
  const endRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    setActiveId(null);
    setStartFresh(false);
    setHistoryOpen(false);
    setHistoryError('');
    setOutside({});
    setError('');
  }, [courseId]);

  useEffect(() => {
    if (!attachment?.type.startsWith('image/')) { setAttachmentPreview(''); return; }
    const url = URL.createObjectURL(attachment);
    setAttachmentPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [attachment]);

  useEffect(() => {
    if (activeId || startFresh || conversations.isLoading || conversations.isError || !conversations.data?.length) return;
    const latest = [...conversations.data].sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))[0];
    setActiveId(latest.id);
  }, [conversations.data, conversations.isLoading, conversations.isError, activeId, startFresh]);

  const messages = messagesQuery.data ?? [];
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages.length, pending]);

  const questionFor = useMemo(() => {
    const map = new Map<string, string>();
    let last = '';
    for (const m of messages) { if (m.role === 'user') last = stripNote(m.content); else map.set(m.id, last); }
    return map;
  }, [messages]);

  const lastAnswerId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role === 'assistant') return (m.citations as unknown as Citation[]).length > 0 ? m.id : null;
    }
    return null;
  }, [messages]);

  async function ask(raw: string, photoPreview?: string) {
    const question = raw.trim();
    if (!question || pending) return;
    setError('');
    setText('');
    setPending(question);
    try {
      let id = activeId;
      if (!id) {
        const created = await createConversation.mutateAsync({ courseId, data: { title: question.slice(0, 60) } });
        id = created.id;
        setActiveId(id);
        setStartFresh(false);
        void qc.invalidateQueries({ queryKey: getListStudyConversationsQueryKey(courseId) });
      }
      const result = await send.mutateAsync({ conversationId: id, data: { content: question + LANG_NOTE[lang] } });
      if (photoPreview) setPhotoPreviews(current => ({ ...current, [result.userMessage.id]: photoPreview }));
      void sendChatSignal(courseId, result.assistantMessage.citations.map(c => c.unitId));
      await qc.invalidateQueries({ queryKey: getListConversationMessagesQueryKey(id) });
      await qc.invalidateQueries({ queryKey: getListStudyConversationsQueryKey(courseId) });
    } catch (e) {
      setError((e as Error).message || 'Something went wrong. Please try again.');
      setText(question);
    } finally { setPending(null); }
  }

  async function submitComposer() {
    if (pending || attachmentBusy) return;
    if (!attachment) { await ask(text); return; }
    const file = attachment;
    setError('');
    setComposerNotice('');
    setAttachmentBusy(true);
    try {
      if (file.type.startsWith('image/')) {
        const photo = await photoAsDataUrl(file);
        try {
          const { question } = await extractPhotoQuestion(courseId, photo);
          setAttachment(null);
          const prompt = `${text.trim() ? `${text.trim()}\n\n` : ''}${PHOTO_QUESTION_MARKER}\n${question}`;
          await ask(prompt, photo);
        } catch (photoError) {
          const typedQuestion = text.trim();
          if (!typedQuestion) {
            const messageByLanguage: Record<Lang, string> = {
              en: "Your photo is still attached. I couldn't read the words in it just now. Type your question and send it with the photo.",
              'en-IN': "Your photo is still attached. I couldn't read its words just now. Type your question and send it with the photo.",
              hi: "आपकी तस्वीर अभी भी लगी हुई है। मैं उसमें लिखे शब्द नहीं पढ़ पाया। अपना सवाल लिखकर तस्वीर के साथ भेजें।",
              hinglish: "Aapki photo abhi bhi attached hai. Main uske words nahi padh paaya. Apna sawaal type karke photo ke saath bhejein.",
              ta: "உங்கள் படம் இன்னும் இணைக்கப்பட்டுள்ளது. அதிலுள்ள எழுத்துகளை இப்போது படிக்க முடியவில்லை. உங்கள் கேள்வியைத் தட்டச்சு செய்து படத்துடன் அனுப்புங்கள்.",
              te: "మీ ఫోటో ఇంకా జతచేయబడి ఉంది. అందులోని పదాలను ఇప్పుడు చదవలేకపోయాను. మీ ప్రశ్నను టైప్ చేసి ఫోటోతో పంపండి.",
              bn: "আপনার ছবিটি এখনো যুক্ত আছে। ছবির লেখা এখন পড়তে পারিনি। আপনার প্রশ্নটি লিখে ছবির সঙ্গে পাঠান।",
              mr: "तुमचा फोटो अजून जोडलेला आहे. त्यातील मजकूर आत्ता वाचता आला नाही. तुमचा प्रश्न लिहून फोटोसह पाठवा.",
            };
            setComposerNotice(messageByLanguage[lang]);
            setError('');
            return;
          }
          setAttachment(null);
          setComposerNotice("Your photo will appear in the chat. I couldn't read its text automatically, so I'll answer the question you typed using your course material.");
          const fallbackPrompt = `${typedQuestion}\n\n${PHOTO_QUESTION_MARKER}\nThe photo is attached, but its text could not be read automatically. Answer only the student's typed question using the course material. Do not claim to see details from the picture.`;
          await ask(fallbackPrompt, photo);
          if (photoError instanceof Error) console.info('Photo reading fell back to the typed question:', photoError.message);
        }
        return;
      }
      const sourceType = classifyAttachment(file);
      if (!sourceType) throw new Error('Attach a photo, PDF, PPTX slide deck, or video file.');
      if (file.size > 500 * 1024 * 1024) throw new Error('Video and source files must be smaller than 500 MB.');
      const signed = await requestUpload.mutateAsync({ data: { name: file.name, size: file.size, contentType: file.type || 'application/octet-stream' } });
      await putFile(file, signed.uploadURL);
      await registerSource.mutateAsync({ data: {
        courseId,
        title: file.name.replace(/\.[^.]+$/, '').slice(0, 300),
        originalFilename: file.name,
        sourceType,
        objectPath: signed.objectPath,
        mimeType: file.type || 'application/octet-stream',
      } });
      setAttachment(null);
      setComposerNotice(`${file.name} was added to this course and is processing. You can ask about it as soon as it shows Ready in the source library.`);
      void qc.invalidateQueries({ queryKey: getListSourcesQueryKey({ courseId }) });
      void qc.invalidateQueries({ queryKey: getListCoursesQueryKey() });
      void qc.invalidateQueries({ queryKey: getGetCourseSummaryQueryKey(courseId) });
    } catch (e) {
      setError((e as Error).message || 'The attachment could not be processed. Please try again.');
    } finally {
      setAttachmentBusy(false);
    }
  }

  function toggleMic() {
    if (!SpeechRecognitionCtor) return;
    if (listening) { recognitionRef.current?.stop(); return; }
    const rec = new SpeechRecognitionCtor();
    rec.lang = speechLang[lang];
    rec.interimResults = false;
    rec.onresult = (event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => {
      const transcript = Array.from(event.results).map(r => r[0].transcript).join(' ');
      setText(prev => (prev ? `${prev} ` : '') + transcript);
    };
    rec.onend = () => setListening(false);
    rec.onerror = (event: { error?: string }) => {
      setListening(false);
      setSpeechStatus(event.error === 'not-allowed' ? 'Allow microphone access in your browser to use voice input.' : `Voice input is unavailable for ${lang === 'hi' ? 'Hindi' : lang === 'ta' ? 'Tamil' : lang === 'te' ? 'Telugu' : lang === 'bn' ? 'Bengali' : lang === 'mr' ? 'Marathi' : 'this language'} in this browser. You can type your question instead.`);
    };
    recognitionRef.current = rec;
    setListening(true);
    rec.start();
  }

  async function removeChat(id: string) {
    setHistoryError('');
    try {
      const r = await fetch(`/api/conversations/${id}`, { method: 'DELETE', credentials: 'same-origin' });
      if (!r.ok && r.status !== 204) throw new Error('failed');
      setConfirmId(null);
      if (activeId === id) { setActiveId(null); setStartFresh(true); setOutside({}); }
      await qc.invalidateQueries({ queryKey: getListStudyConversationsQueryKey(courseId) });
    } catch { setHistoryError('Could not delete that chat. Please try again.'); }
  }

  function speak(content: string, id: string) {
    if (!('speechSynthesis' in window)) return;
    const wasSpeakingThis = speakingId === id;
    window.speechSynthesis.cancel();
    if (wasSpeakingThis) { setSpeakingId(null); return; }
    const utter = new SpeechSynthesisUtterance(content);
    utter.lang = speechLang[lang];
    const locale = utter.lang.toLowerCase();
    const voices = availableVoices.length ? availableVoices : window.speechSynthesis.getVoices();
    const matchingVoice = voices.find(voice => voice.lang.replace('_', '-').toLowerCase() === locale)
      ?? voices.find(voice => voice.lang.replace('_', '-').toLowerCase().startsWith(`${locale.split('-')[0]}-`));
    if (matchingVoice) setSpeechStatus('');
    else if (!lang.startsWith('en')) setSpeechStatus(`No ${lang === 'hi' ? 'Hindi' : lang === 'ta' ? 'Tamil' : lang === 'te' ? 'Telugu' : lang === 'bn' ? 'Bengali' : lang === 'mr' ? 'Marathi' : 'matching'} speech voice is installed in this browser. Add that language’s voice in your device settings, then try Listen again.`);
    else setSpeechStatus('');
    if (matchingVoice) utter.voice = matchingVoice;
    utter.onend = () => setSpeakingId(cur => (cur === id ? null : cur));
    utter.onerror = () => { setSpeakingId(cur => (cur === id ? null : cur)); setSpeechStatus('Your browser could not play this voice. Try another installed voice or use the text answer.'); };
    setSpeakingId(id);
    window.speechSynthesis.resume();
    window.speechSynthesis.speak(utter);
  }

  async function loadOutside(messageId: string) {
    const question = questionFor.get(messageId);
    if (!question) return;
    setOutside(prev => ({ ...prev, [messageId]: { loading: true } }));
    try {
      const out = await askOutsideKnowledge(courseId, question + LANG_NOTE[lang]);
      setOutside(prev => ({ ...prev, [messageId]: { answer: out.answer } }));
    } catch (e) { setOutside(prev => ({ ...prev, [messageId]: { error: (e as Error).message } })); }
  }

  const empty = !messagesQuery.isLoading && !messagesQuery.isError && messages.length === 0 && !pending;
  const readySource = courseSources.data?.find(source => source.status === 'ready');
  const starterPrompts = readySource
    ? [...STARTERS, { label: `Summarise ${readySource.title}`, prompt: `Summarise ${readySource.title}` }]
    : STARTERS;

  return <div className="flex min-h-[60dvh] flex-col">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <p className="max-w-xl text-sm leading-6 text-[#718075]">Answers come only from your uploaded material, with citations that open the exact page, slide, or video moment. If the material doesn't cover a question, the tutor says so.</p>
      <div className="flex items-center gap-2">
        <div className="relative">
          <button onClick={() => { setHistoryOpen(o => !o); setConfirmId(null); setHistoryError(''); if (!historyOpen) void conversations.refetch(); }} aria-expanded={historyOpen} className={ghostBtn} data-testid="button-chat-history"><History size={14} /> History {conversations.isLoading ? '…' : `(${conversations.data?.length ?? 0})`}</button>
          {historyOpen && <>
            <div className="fixed inset-0 z-20" onClick={() => setHistoryOpen(false)} aria-hidden="true" />
            <div role="dialog" aria-label="Previous chats" className="cx-pop-in absolute right-0 top-full z-30 mt-2 w-[min(360px,86vw)] rounded-2xl border border-[#dcd8cc] bg-[#fbfaf5] p-2 shadow-[0_18px_44px_rgba(37,71,60,.16)]">
              <div className="flex items-center justify-between px-2 pb-1 pt-1"><span className="font-mono-ui text-[10px] uppercase tracking-[.14em] text-[#a67d4d]">Your chats</span><button onClick={() => setHistoryOpen(false)} className="text-xs text-[#718075] hover:text-[#25473c]">Close</button></div>
              {conversations.isLoading && <p className="px-3 py-4 text-sm text-[#718075]">Loading saved chats…</p>}
              {conversations.isError && <div className="px-3 py-3"><p role="alert" className="text-sm text-[#a45e52]">Could not load saved chats: {(conversations.error as Error).message}</p><button onClick={() => void conversations.refetch()} className="mt-2 text-xs font-semibold text-[#365647] underline">Try again</button></div>}
              {!conversations.isLoading && !conversations.isError && !conversations.data?.length && <p className="px-3 py-4 text-sm text-[#718075]">No saved chats for this course yet. New conversations are saved automatically.</p>}
              <ul className="max-h-[340px] space-y-1 overflow-y-auto pr-1">
                {[...(conversations.data ?? [])].sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt)).map(c => {
                  const count = (c as { messageCount?: number }).messageCount ?? 0;
                  const asking = confirmId === c.id;
                  return <li key={c.id} className={`group flex items-center gap-2 rounded-xl px-3 py-2 transition ${activeId === c.id ? 'bg-[#e8efe6]' : 'hover:bg-[#f1eee4]'}`}>
                    {asking
                      ? <><span className="flex-1 text-sm text-[#854f45]">Delete this chat?</span>
                        <button onClick={() => void removeChat(c.id)} className="rounded-full bg-[#a45e52] px-3 py-1 text-xs font-semibold text-white hover:bg-[#8a4a3f]">Delete</button>
                        <button onClick={() => setConfirmId(null)} className="rounded-full border border-[#d4d3c7] px-3 py-1 text-xs text-[#4d6358] hover:bg-white">Keep</button></>
                      : <><button onClick={() => { setStartFresh(false); setActiveId(c.id); setError(''); setOutside({}); setHistoryOpen(false); }} className="min-w-0 flex-1 text-left">
                          <span className="block truncate text-sm font-medium text-[#25473c]">{c.title}</span>
                          <span className="block text-[11px] text-[#718075]">{count} message{count === 1 ? '' : 's'} · {new Date(c.updatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
                        </button>
                        <button onClick={() => setConfirmId(c.id)} aria-label={`Delete chat ${c.title}`} className="rounded-full p-1.5 text-[#9aa79c] opacity-60 transition hover:bg-[#f6e4df] hover:text-[#a45e52] group-hover:opacity-100"><Trash2 size={14} /></button></>}
                  </li>;
                })}
              </ul>
              {historyError && <p role="alert" className="px-2 pt-2 text-xs text-[#a45e52]">{historyError}</p>}
            </div>
          </>}
        </div>
        <button onClick={() => { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); setSpeakingId(null); setStartFresh(true); setActiveId(null); setText(''); setError(''); setOutside({}); }} className={ghostBtn}><Plus size={14} /> New chat</button>
      </div>
    </div>

    <div className="cx-messages flex-1 space-y-4">
      {activeId && messagesQuery.isLoading && <div className={card}><Spinner label="Loading this saved conversation…" /></div>}
      {activeId && messagesQuery.isError && <div role="alert" className="rounded-2xl border border-[#e5c7c0] bg-[#faf0ed] p-4 text-sm text-[#854f45]">This conversation could not be loaded: {(messagesQuery.error as Error).message}<button onClick={() => void messagesQuery.refetch()} className="ml-2 font-semibold underline">Try again</button></div>}
      {empty && <div className={`${card} text-center`}>
        <h3 className="font-editorial text-2xl text-[#25473c]">Ask anything from your course</h3>
        <p className="mx-auto mt-2 max-w-md text-sm text-[#718075]">Say hi, or ask something like “Explain the main idea of the first lecture”, or ask about a diagram on a slide.</p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">{starterPrompts.map(t => <button key={t.label} onClick={() => void ask(t.prompt)} className={chipBtn}>{t.label}</button>)}</div>
      </div>}
      {messages.map(m => {
        const citations = m.citations as unknown as Citation[];
        if (m.role === 'user') {
          const content = stripNote(m.content);
          const photoMarkerAt = content.indexOf(PHOTO_QUESTION_MARKER);
          const photoPrompt = photoMarkerAt >= 0;
          const caption = photoPrompt ? content.slice(0, photoMarkerAt).trim() : content;
          return <div key={m.id} className="flex justify-end"><div className="max-w-[85%] overflow-hidden rounded-2xl rounded-br-md bg-[#25473c] p-3 text-sm leading-6 text-[#f7f3e8]">
            {photoPrompt && photoPreviews[m.id] && <img src={photoPreviews[m.id]} alt="Your uploaded question" className="mb-2 max-h-72 max-w-full rounded-xl object-contain" />}
            {photoPrompt ? <><p className="font-medium">Question photo</p>{caption && <p className="mt-1 text-[#dce8dd]">{caption}</p>}</> : content}
          </div></div>;
        }
        const parsed = parseAssistant(m.content);
        const unsupported = citations.length === 0 && !parsed.isChat;
        const extra = outside[m.id];
        return <div key={m.id} className="max-w-[94%] sm:max-w-[92%]">
          <div className={`${card} ${unsupported ? 'border-[#e3cf9f] bg-[#fbf6e6]' : parsed.isChat ? 'border-[#cfdccf] bg-[#f1f6ee]' : ''}`}>
            {unsupported && <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-[#8a6a1f]"><TriangleAlert size={14} /> {NOT_COVERED_LABEL[lang]}</div>}
            <MarkdownAnswer>{parsed.text}</MarkdownAnswer>
            {citations.length > 0 && <div className="mt-3"><CitationChips citations={citations} /></div>}
            {parsed.tries.length > 0 && <div className="mt-3 flex flex-wrap gap-2" aria-label="Suggested questions">
              {parsed.tries.map(t => <button key={t} onClick={() => void ask(t)} disabled={!!pending} className={chipBtn}>{t}</button>)}
            </div>}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {'speechSynthesis' in window && parsed.text && <button onClick={() => speak(parsed.text, m.id)} className="inline-flex items-center gap-1 text-xs text-[#718075] hover:text-[#25473c]" aria-label={speakingId === m.id ? 'Stop reading' : 'Read aloud'}>{speakingId === m.id ? <><Square size={13} fill="currentColor" /> Stop</> : <><Volume2 size={14} /> Listen</>}</button>}
              {unsupported && !extra && <button onClick={() => loadOutside(m.id)} className="inline-flex items-center gap-1 text-xs font-semibold text-[#8a6a1f] hover:underline"><Globe size={14} /> {GENERAL_EXPLANATION_LABEL[lang]}</button>}
            </div>
            {extra?.loading && <div className="mt-3"><Spinner label="Thinking…" /></div>}
            {extra?.error && <div className="mt-3"><ErrorNote message={extra.error} /></div>}
            {extra?.answer && <div className="mt-3 rounded-xl border border-dashed border-[#c9b48a] bg-white/60 p-3 text-[#5b5130]">
              <div className="font-mono-ui mb-1 text-[10px] uppercase tracking-[.14em] text-[#a67d4d]">Outside your material · not source-backed</div><MarkdownAnswer>{extra.answer}</MarkdownAnswer></div>}
            {citations.length > 0 && m.id === lastAnswerId && <div className="mt-3 flex flex-wrap gap-2" aria-label="Follow-up options">
              {FOLLOW_UPS.map(f => <button key={f.label} onClick={() => void ask(f.prompt)} disabled={!!pending} className={chipBtn}>{f.label}</button>)}
            </div>}
            {citations.length > 0 && <InlineCheck courseId={courseId} unitIds={citations.map(c => c.unitId)} />}
          </div>
        </div>;
      })}
      {pending && <>
        <div className="flex justify-end"><div className="max-w-[85%] rounded-2xl rounded-br-md bg-[#25473c] px-4 py-3 text-sm text-[#f7f3e8]">{pending}</div></div>
        <div className={`${card} max-w-[94%] sm:max-w-[92%]`}>
          <Spinner label="Thinking through your course materials…" />
        </div>
      </>}
      <div ref={endRef} />
    </div>

    {error && <div className="mt-3"><ErrorNote message={error} /></div>}
    {composerNotice && <div role="status" className="mt-3 rounded-xl border border-[#cbdcc9] bg-[#edf5ea] px-4 py-3 text-sm leading-6 text-[#365d45]">{composerNotice}</div>}
    {speechStatus && <div role="status" className="mt-2 rounded-xl border border-[#e5dfcf] bg-[#f7f4eb] px-3 py-2 text-xs leading-5 text-[#6b6555]">{speechStatus}</div>}
    <form className="cx-composer sticky bottom-[max(0.75rem,env(safe-area-inset-bottom))] mt-4 flex w-full min-w-0 flex-col gap-2 rounded-2xl border border-[#d4d3c7] bg-[#fbfaf5] p-2 shadow-sm" onSubmit={e => { e.preventDefault(); void submitComposer(); }}>
      <div className="flex min-w-0 items-center gap-2 px-2 pt-1">
        <Globe size={14} className="shrink-0 text-[#a67d4d]" />
        <label htmlFor="tutor-lang" className="shrink-0 text-xs font-medium text-[#718075]">Reply in</label>
        <select id="tutor-lang" value={lang} onChange={e => { manuallySelectedLanguage.current = true; setLang(e.target.value as Lang); }} className="min-w-0 rounded-full border border-[#e1ddd2] bg-white px-3 py-1.5 text-xs font-semibold text-[#365647] outline-none transition focus:border-[#65806c]">
          <option value="en">English</option><option value="en-IN">English (India)</option><option value="hi">हिन्दी</option><option value="hinglish">Hinglish</option>
          <option value="ta">தமிழ் · Tamil</option><option value="te">తెలుగు · Telugu</option><option value="bn">বাংলা · Bengali</option><option value="mr">मराठी · Marathi</option>
        </select>
        <span className="ml-auto hidden truncate text-[10px] text-[#899084] sm:block">Replies and read-aloud use this language</span>
      </div>
      <input ref={fileInputRef} type="file" accept=".pdf,.pptx,video/*,.mp4,.mov,.m4v,.webm,.avi,.mkv,.mpeg,.mpg,.3gp,.wmv,.flv,.m2ts" className="sr-only" aria-label="Attach a PDF, slide deck, or video" onChange={e => { setAttachment(e.target.files?.[0] ?? null); setComposerNotice(''); setError(''); e.currentTarget.value = ''; }} />
      <input ref={photoInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/tiff,.tif,.tiff" capture="environment" className="sr-only" aria-label="Take or choose a question photo" onChange={e => { setAttachment(e.target.files?.[0] ?? null); setComposerNotice(''); setError(''); e.currentTarget.value = ''; }} />
      <div className="flex w-full min-w-0 items-end gap-2">
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={() => photoInputRef.current?.click()} disabled={!!pending || attachmentBusy} aria-label="Take a photo of a question" title="Question photo" className="rounded-full p-2.5 text-[#718075] hover:bg-[#efede4] disabled:opacity-40"><ImagePlus size={17} /></button>
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={!!pending || attachmentBusy} aria-label="Attach a PDF, slide deck, or video" title="Attach a PDF, slides, or video" className="rounded-full p-2.5 text-[#718075] hover:bg-[#efede4] disabled:opacity-40"><Paperclip size={17} /></button>
        </div>
        <div className="min-w-0 flex-1">
          {attachment && <div className="mb-2 flex min-w-0 items-center gap-2 rounded-xl bg-[#f1eee4] px-2.5 py-2 text-xs text-[#4d6358]">
            {attachmentPreview ? <img src={attachmentPreview} alt="Selected question photo" className="h-9 w-9 rounded-lg object-cover" /> : <Paperclip size={14} className="shrink-0" />}
            <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
            <button type="button" onClick={() => setAttachment(null)} disabled={attachmentBusy} aria-label="Remove attachment" className="rounded-full p-1 hover:bg-white disabled:opacity-40"><X size={14} /></button>
          </div>}
          <label htmlFor="tutor-input" className="sr-only">Your question</label>
          <textarea id="tutor-input" value={text} onChange={e => { setText(e.target.value); e.currentTarget.style.height = 'auto'; e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 128)}px`; }} rows={1} placeholder="Ask about your course material…" enterKeyHint="send"
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submitComposer(); } }}
            className="block max-h-32 min-h-[44px] w-full min-w-0 resize-none bg-transparent px-3 py-2.5 text-base text-[#25473c] outline-none placeholder:text-[#9aa398] sm:text-sm" />
        </div>
        {SpeechRecognitionCtor && <button type="button" onClick={toggleMic} aria-label={listening ? 'Stop dictation' : 'Dictate question'} className={`shrink-0 rounded-full p-3 ${listening ? 'bg-[#c9776a] text-white' : 'text-[#718075] hover:bg-[#efede4]'}`}><Mic size={17} /></button>}
        <button type="submit" disabled={(!text.trim() && !attachment) || !!pending || attachmentBusy} aria-label={attachmentBusy ? 'Processing attachment' : 'Send'} className="shrink-0 rounded-full bg-[#25473c] p-3 text-[#f7f3e8] disabled:opacity-40">{attachmentBusy ? <span className="block h-[17px] w-[17px] animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Send size={17} />}</button>
      </div>
    </form>
  </div>;
}

# Citexa: Source-Grounded Adaptive Study Companion

> **A clearer way through your course material.**  
> Citexa turns lecture slides, readings, PDFs, YouTube recordings, and notes into an organized, fully traceable AI study workspace where every concept links directly back to its original source.

---

##  Overview

**Citexa** is an intelligent, source-grounded learning ecosystem designed to bridge the gap between heavy course content and effective study habits. Instead of generating untraceable AI notes, Citexa retains complete provenance—mapping generated study units, flashcards, concept maps, and quizzes directly back to exact page numbers, timestamps, and slide sources.

---

##  Key Features

###  1. Source-Grounded Study Workspace
* **Traceable by Design:** Answers and insights cite precise source locations (e.g., PDF page numbers, video timestamps).
* **Multi-Format Ingestion:** Process PDFs, slide decks, lecture recordings, handwritten notes, and YouTube lectures.
* **Strict Source Guardrails:** If a concept isn't covered in your uploaded materials, the AI tutor explicitly states that it's missing from the source context.

###  2. Interactive Course Map & Knowledge Graphs
* **Prerequisite Mapping:** Visual dependency trees showing how foundational concepts build toward advanced topics.
* **Mastery Color-Coding:** Real-time visual tracking across topics (`Untested`, `Weak`, `Learning`, `Strong`).

###  3. Analytics & Progress Dashboard
* **Mastery Over Time:** Tracks your retention and concept mastery trends across quizzes and study sessions.
* **Review Queues:** Highlights weak concepts and items due for review based on forgetting curve models.

###  4. Exam Lab & Revision Suite
* **Past-Paper Priority Guide:** Ranks recurring course topics across past papers with linked passage evidence.
* **Auto-Generated Flashcards:** Focuses specifically on weak topics, linked directly to source material.
* **Course Glossary:** Plain-language definitions extracted from materials, mapped directly to their occurrences.
* **Cheat Sheets:** Concise, source-supported definitions, formulas, and examples ready for export or printing.

###  5. Gamified Study Rhythms & Goals
* **Daily Goal Tracking:** Set custom daily study targets (e.g., 90 mins/day) with in-app reminder preferences.
* **XP & Streak System:** Earn XP by logging focused study blocks and mastering concepts.

---

##  Application Architecture & Views

| Interface View | Description |
| :--- | :--- |
| **Landing Page** | Overview of the platform, features, and quick onboarding. |
| **Course Library** | Workspace hub showing all enrolled courses, uploaded sources, and assembled study units. |
| **Course Detail View** | Source management center for uploading PDFs, slide decks, and YouTube links. |
| **Video & PDF Source Viewer** | Interactive media player synced with chapter navigation and transcript timestamps. |
| **Study Workspace (Tutor)** | Interactive AI tutor grounded strictly in your selected course materials. |
| **Practice Quizzes** | Dual-model verified practice questions tied to exact source timestamps/pages. |
| **Analytics Dashboard** | Performance stats, mastery metrics over time, and retention predictions. |
| **Course Map** | Interactive visual node graph mapping prerequisite relationships between concepts. |
| **Adaptive Revision** | Spaced-repetition review queues, flashcards, and personalized study schedules. |
| **Exam Lab Suite** | Centralized hub for Cheat Sheets, Glossaries, Past-Paper Priority Guides, and Daily Goals. |

---

##  Tech Stack

* **Frontend:** React / Modern Web Interface
* **Styling:** Custom CSS / Tailwind CSS (Warm, minimal editorial design system)
* **Backend:** Node.js / Python
* **Deployment:** Hosted on [Render](https://render.com/)

---

##  Getting Started

### Prerequisites

* [Node.js](https://nodejs.org/) (v18.0 or higher)
* `npm` or `yarn`

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/your-username/citexa.git
   cd citexa
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up environment variables:**
   Create a `.env` file in the root directory and add required API keys:
   ```env
   PORT=5000
   DATABASE_URL=your_database_url
   LLM_API_KEY=your_llm_api_key
   ```

4. **Run the development server:**
   ```bash
   npm run dev
   ```

5. **Open in browser:**  
   Navigate to `http://localhost:3000` to access Citexa.

---

##  Contributing

Contributions are always welcome! If you have suggestions for improvements, feature requests, or bug reports:

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git checkout -b feature/AmazingFeature`)
5. Open a Pull Request

---

##  License

Distributed under the MIT License. See `LICENSE` for more information.

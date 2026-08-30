<div align="center">

# 🎬 CineMatch AI
### The Agentic Continuity & Production Intelligence Suite for Film Sets

**Lights. Camera. Code.**
Built for **Agentic Cinema: The Blockbuster Hackathon**

[![Google Cloud](https://img.shields.io/badge/Google%20Cloud-Run-4285F4?logo=googlecloud&logoColor=white)](#)
[![Vertex AI](https://img.shields.io/badge/Vertex%20AI-Gemini%203.6-8E75B2?logo=googlegemini&logoColor=white)](#)
[![Firestore](https://img.shields.io/badge/Firestore-Database-FFA000?logo=firebase&logoColor=white)](#)
[![Veo 3.1](https://img.shields.io/badge/Veo%203.1-Video%20Gen-EA4335?logo=googlegemini&logoColor=white)](#)
[![Lyria 3](https://img.shields.io/badge/Lyria%203-Music%20Gen-34A853?logo=googlegemini&logoColor=white)](#)
[![Node.js](https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white)](#)
[![License](https://img.shields.io/badge/status-hackathon%20build-lightgrey)](#)

</div>

---
## 🚀 Live Links
- **Live Application**: https://cinematch-ai-service-801225879799.us-central1.run.app
- **Demo Video**: https://vimeo.com/1222494860?share=copy&fl=sv&fe=ci#t=0
## 🎥 The Pitch

Every film production loses money to the same invisible enemy: **continuity drift**. A coffee cup that switches hands between takes. A jacket that's unbuttoned in the wide shot and buttoned in the close-up. A prop that vanishes from the shelf three scenes later. On a real set, this is caught by a script supervisor flipping through binders — if it's caught at all. Reshoots for continuity errors routinely cost productions **tens of thousands of dollars per day**.

**CineMatch AI** replaces the binder with a team of autonomous AI agents that never blink.

It's not a single chatbot bolted onto a form — it's an **orchestrated multi-agent system**, built on Google's Agent Development Kit (ADK) and Gemini 3.6, that watches footage, reads scripts, queries a live production database, scouts real-world locations, and pre-visualizes shots *before* the crew ever rolls camera.

---

## 🧠 Why This Wins: The Agentic Architecture

At the heart of CineMatch is a genuine **orchestrator → specialist agent** hierarchy, not a single prompt wearing different hats:

```
                         ┌─────────────────────────────┐
                         │   CineMatch_Master_Agent     │
                         │   (gemini-3.6-pro)           │
                         │   "Delegate & synthesize"    │
                         └───────────────┬──────────────┘
                 ┌───────────────────────┼───────────────────────┐
                 ▼                       ▼                       ▼
     ┌───────────────────┐   ┌─────────────────────┐   ┌────────────────────┐
     │ Continuity_Agent   │   │ Production_Agent    │   │  Safety_Agent       │
     │ gemini-3.6-flash   │   │ gemini-3.6-flash     │   │  gemini-3.6-flash   │
     │ Script + visual    │   │ Cast/crew/equipment  │   │  Location & set     │
     │ consistency        │   │ logistics             │   │  safety analysis    │
     │                    │   │                       │   │                     │
     │ 🔧 mcp_query_vault │   │ 🔧 mcp_query_vault    │   │  🔧 searchLocations │
     └────────┬───────────┘   └──────────┬───────────┘   └──────────┬──────────┘
              │                          │                          │
              ▼                          ▼                          ▼
       Firestore (MCP)            Firestore (MCP)            Google Maps API
```

Each specialist agent is armed with real, callable **tools** exposed via a Model-Context-Protocol-style function schema — `mcp_query_vault` lets any agent autonomously query live Firestore collections (`scenes`, `cast`, `equipment`, `assets`) for grounded, hallucination-free answers, and `searchLocations` lets the Safety agent pull real Google Maps data on filming locations and crew amenities. The **Production Planning Agent** goes further: it runs a full multi-turn tool-calling loop, deciding *for itself* when it needs to hit the database again before it's confident enough to answer.

This is agentic AI doing what agentic AI is supposed to do: **reason, decide, call tools, and act** — not just generate text.

---

## ✨ What It Actually Does

CineMatch bundles **20+ purpose-built AI agents** into a single command-center workspace for a production. A few highlights:

| Agent | What it solves |
|---|---|
| 🎞️ **Continuity Graph Audit** | Cross-references script pages against footage to build a continuity graph and flag drift |
| 🔍 **Take-to-Take Comparison** | Compares multiple takes of the same shot for prop, wardrobe & blocking mismatches |
| 🧠 **Narrative Memory** | Persists story/character facts across the whole shoot so nothing contradicts itself 40 scenes later |
| 🧍 **Character State Tracking** | Tracks a character's physical/emotional state (injuries, wardrobe, props) shot-to-shot from video |
| 🗺️ **Scene Spatial Memory** | Builds spatial awareness of a set from video so blocking stays consistent |
| 🎥 **Camera Continuity Auditor** | Flags lens, angle, and movement mismatches between coverage |
| 🖼️ **Pre-Vis Storyboard** | Generates storyboard imagery + narration straight from a scene description |
| 🎬 **Pre-Vis Video Generation** | Turns a scene description into an optimized **Veo 3.1** prompt and renders an 8s pre-vis clip *with synchronized audio* |
| 🔊 **Audio Continuity Agent** | Checks dialogue/audio takes for continuity issues |
| 🎙️ **Dialogue Sentiment Analysis** | Analyzes the emotional delivery of a take against the intended tone |
| 🎵 **Music Generation** | Composes original score cues on demand via **Lyria 3** |
| 🎧 **Multi-Speaker Podcast** | Generates production recap podcasts with distinct AI voices via Gemini TTS |
| ⚠️ **Production Risk / Pre-Shoot Risk** | Surfaces safety, budget, and schedule risk *before* and *during* a shoot day |
| 📋 **Production Planning Agent** | Tool-calling agent that queries live Firestore to answer logistics questions on cast, equipment, and scene status |
| 🗺️ **Google Maps Location Scout** | Finds and evaluates real-world filming locations and crew amenities |
| 🎙️ **Gemini Live: Director's Assistant** | A real-time, bidirectional **voice** agent (WebSocket → Gemini Live API) the director can literally talk to on set |
| 📝 **Video Transcription** | Full transcript generation straight from dailies |

Every agent's output feeds a shared **Command Center**: live agent activity feed, aggregated findings, pending decisions, and production alerts — so a first AD or script supervisor sees the whole shoot's health at a glance.

---

## 🏗️ Tech Stack

| Layer | Technology |
|---|---|
| **Orchestration** | Google Agent Development Kit (`@google/adk`) — `LlmAgent` orchestrator + specialist sub-agents |
| **Reasoning / Vision** | Vertex AI **Gemini 3.6 Pro / Flash** (multimodal script + video analysis) |
| **Video Generation** | **Veo 3.1** (text-to-video with native audio synthesis) |
| **Music Generation** | **Lyria 3** (via the Gemini Interactions API) |
| **Voice** | **Gemini Live API** over a secured WebSocket relay for real-time bidirectional audio |
| **Database** | **Firestore** — production vault (`scenes`, `cast`, `equipment`, `assets`, audit history) queried live by agents via a tool-calling schema |
| **Storage** | **Google Cloud Storage** for footage, storyboards, and generated media |
| **Location Intelligence** | **Google Maps Platform** (`@googlemaps/google-maps-services-js`) |
| **Backend** | Node.js 22 · Express 5 · Multer (media uploads) · `ws` (WebSocket server) |
| **Transactional Email** | Resend API (support & report delivery) |
| **Observability** | OpenTelemetry auto-instrumentation → OTLP export (Grafana Cloud–ready) |
| **Deployment** | Docker → **Google Cloud Run**, deployed via **Cloud Build**, secrets in **Secret Manager** |

**Guardrails by design:** every generation call runs through configurable Vertex AI safety settings (harassment, hate speech, sexual content, dangerous content) with a graceful fallback that surfaces a `CRITICAL_REVIEW_REQUIRED` flag instead of silently failing — appropriate for an enterprise studio pipeline.

---

## ☁️ Cloud-Native by Default

This isn't a demo running on a laptop — it ships as a real production service:

- **Dockerized** (`node:22-slim`) with OpenTelemetry pre-loaded via `--import`
- **Cloud Build pipeline** (`cloudbuild.yaml`): build → push to Artifact Registry → deploy to Cloud Run, fully automated
- **Secrets** (`GEMINI_API_KEY`, `GOOGLE_MAPS_API_KEY`, `RESEND_API_KEY`) injected from **Secret Manager** at deploy time — never hardcoded
- **Knative Service spec** (`service.yaml`) for declarative, autoscaling (max 5 instances) Cloud Run deployment
- Application-level auth scaffolding via `bcryptjs` + `jsonwebtoken`, ready for multi-user studio access

---

## 🚀 Getting Started

### Prerequisites
- Node.js 22+
- A Google Cloud project with Vertex AI, Firestore, and Cloud Storage enabled
- API keys for Gemini, Google Maps, and Resend

### 1. Clone & install
```bash
git clone <your-repo-url>
cd cinematch-ai
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```
```env
GEMINI_API_KEY=your_gemini_key_here
GOOGLE_CLOUD_PROJECT_ID=your_gcp_project_id
GOOGLE_MAPS_API_KEY=your_google_maps_key_here
RESEND_API_KEY=your_resend_key_here
SUPPORT_EMAIL=your_email@example.com

# Optional: OpenTelemetry / Grafana
OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
OTEL_EXPORTER_OTLP_ENDPOINT="https://otlp-gateway-prod.grafana.net/otlp"
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic%20YOUR_BASE64_TOKEN"
```

### 3. Run locally
```bash
node --import ./tracing.js server.js
```
Open **http://localhost:8080**.

### 4. Deploy to Google Cloud Run
```bash
gcloud builds submit --config cloudbuild.yaml
```
Cloud Build handles the container build, Artifact Registry push, and Cloud Run deploy in one shot — secrets are pulled straight from Secret Manager.

---

## 🎯 Built For

**Agentic Cinema: The Blockbuster Hackathon** (Google) — showcasing genuine multi-agent orchestration, live database-grounded tool calling, and the Gemini generative media stack (Gemini, Veo, Lyria, Live API) applied to a real, high-cost industry problem: **keeping a film set continuous, safe, and on schedule.**

---

<div align="center">

*CineMatch AI — because the only thing that should change between takes is the performance.*

</div>

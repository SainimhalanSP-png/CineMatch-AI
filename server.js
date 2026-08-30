import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from '@google/genai';
import { Storage } from '@google-cloud/storage';
import { GoogleAuth } from 'google-auth-library';
import { db, Users, AuditHistory } from './models.js';
import { Client as GoogleMapsClient } from "@googlemaps/google-maps-services-js";
import WebSocket, { WebSocketServer } from 'ws';
const mapsClient = new GoogleMapsClient({});
// 1. IMPORT THE OFFICIAL ADK
import { LlmAgent } from '@google/adk';

// 2. DEFINE THE TOOLS GLOBALLY FIRST
const mcpQueryVaultTool = {
    name: "mcp_query_vault",
    description: "Model Context Protocol (MCP) tool to query the Firestore production database for actor schedules, scene status, equipment, and asset availability.",
    parameters: {
        type: "OBJECT",
        properties: {
            collection: { type: "STRING", description: "The Firestore collection to query (e.g., 'scenes', 'cast', 'equipment', 'assets')" },
            documentId: { type: "STRING", description: "Specific document ID to fetch (optional)" },
            searchIntent: { type: "STRING", description: "What information the agent is looking for" }
        },
        required: ["collection", "searchIntent"]
    }
};

const mapsScoutTool = {
    name: 'searchLocations',
    description: 'Use this tool to search Google Maps for real-world filming locations, crew amenities, or points of interest.',
    parameters: {
        type: 'OBJECT',
        properties: {
            query: { type: 'STRING', description: 'What to search for (e.g., "coffee shops", "industrial parks")' },
            location: { type: 'STRING', description: 'The city or area to search in (e.g., "London", "Los Angeles")' }
        },
        required: ['query', 'location']
    }   
};

// 3. DEFINE THE SPECIALIST SUB-AGENTS
const continuityAgent = new LlmAgent({
    name: 'Continuity_Agent',
    model: 'gemini-3.6-flash',
    instruction: 'Analyze script continuity and visual consistency. Use the MCP tool to check past records.',
    tools: [mcpQueryVaultTool] 
});

const productionAgent = new LlmAgent({
    name: 'Production_Agent',
    model: 'gemini-3.6-flash',
    instruction: 'Manage cast, crew, and equipment logistics.',
    tools: [mcpQueryVaultTool]
});

const safetyAgent = new LlmAgent({
    name: 'Safety_Agent',
    model: 'gemini-3.6-flash',
    instruction: 'Analyze locations for physical production safety.',
    tools: [mapsScoutTool] 
});

// 4. DEFINE THE MASTER ORCHESTRATOR
const masterAgent = new LlmAgent({
    name: 'CineMatch_Master_Agent',
    model: 'gemini-3.6-pro',
    instruction: 'You are the CineMatch Master Orchestrator. Delegate tasks to the Continuity, Production, and Safety agents to fully evaluate the production scene.',
    agents: [continuityAgent, productionAgent, safetyAgent] 
});

// Inside your orchestrator route, you now simply call:
// const response = await masterAgent.invoke(userPrompt);


dotenv.config();

// ----------------------------

// Initialize Default Firestore User
async function initFirestore() {
    try {
        const userRef = Users.doc('director@cinematch.ai');
        const doc = await userRef.get();
        
        if (!doc.exists) {
            await userRef.set({
                email: 'director@cinematch.ai',
                createdAt: new Date().toISOString()
            });
            console.log('✅ Default Firebase session user created.');
        } else {
            console.log('✅ Firebase Connected: Persistent State Enabled');
        }
    } catch (err) {
        console.error('🚨 Firestore initialization error:', err);
    }
}
initFirestore();

// Initialize Vertex AI using your secure terminal login & project credits
const ai = new GoogleGenAI({
    project: 'project-051c2796-a8db-43d9-99c',
    location: 'us',
    vertexai: {
        project: 'project-051c2796-a8db-43d9-99c',
        location: 'us'
    },
    httpOptions: {
        timeout: 600000 // 10 minutes in milliseconds
    }
});

// ==========================================
// ENTERPRISE SAFETY GUARDRAILS
// ==========================================
const studioSafetySettings = [
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
];

const systemInstruction = `
You are CineMatch AI, an enterprise-grade film production continuity system.
Rules for safety compliance:
1. Do not generate actionable instructions for dangerous physical stunts or hazardous chemical setups.
2. Flag any high-risk set safety hazards explicitly under the Production Risk report.
3. Keep all script evaluations professional, unbiased, and compliant with studio PG-13/R production standards.
`;

// Wrapper to handle safety blocks gracefully across all parallel agents
async function safeAgentCall(contents, agentName) {
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: [...contents, systemInstruction],
            config: {
                safetySettings: studioSafetySettings,
                temperature: 0.2
            }
        });
        
        const candidate = response.candidates?.[0];
        if (candidate?.finishReason === 'SAFETY' || !candidate?.content) {
            console.warn(`[GUARDRAIL TRIGGERED] ${agentName} blocked by safety filters.`);
            return { text: `[SAFETY GUARDRAIL TRIGGERED] The content requested for ${agentName} analysis violated studio safety protocols and was withheld. Risk Level: CRITICAL_REVIEW_REQUIRED.` };
        }
        return { text: response.text };
    } catch (error) {
        console.error(`Error in ${agentName}:`, error.message);
        return { text: `[AGENT ERROR] Failed to complete ${agentName} analysis due to a system error.` };
    }
}

// Initialize Google Cloud Storage
const storage = new Storage({
    projectId: 'project-051c2796-a8db-43d9-99c'
});
const BUCKET_NAME = 'cinematch-assets-051c2796';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

const upload = multer({ dest: 'uploads/' });
const memoryUpload = multer({ storage: multer.memoryStorage() });
// Screenshots attached to Help Center / Send Feedback / Report a Bug submissions.
const supportUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 4 },
    fileFilter: (req, file, cb) => cb(null, /^image\//i.test(file.mimetype))
});

// ==========================================
// PERSISTENT MEDIA LIBRARY HELPERS
// Anonymous hackathon workspace: no login is required.
// Generated Studio assets are stored in GCS and indexed in Firestore.
// ==========================================
const MediaLibrary = db.collection('mediaLibrary');
const IntelligenceHistory = db.collection('intelligenceHistory');
const SupportMessages = db.collection('supportMessages');
const LIBRARY_SIGNED_URL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function decodeDataUri(value) {
    if (typeof value !== 'string') return null;
    const match = value.match(/^data:([^;,]+)?(?:;base64)?,([\s\S]*)$/i);
    if (!match) return null;
    const mimeType = match[1] || 'application/octet-stream';
    const isBase64 = /;base64,/i.test(value.slice(0, value.indexOf(',')));
    const buffer = isBase64
        ? Buffer.from(match[2], 'base64')
        : Buffer.from(decodeURIComponent(match[2]), 'utf8');
    return { buffer, mimeType };
}

function extensionForMime(mimeType = '') {
    const map = {
        'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
        'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
        'video/mp4': 'mp4', 'application/json': 'json',
        'text/markdown': 'md', 'text/plain': 'txt'
    };
    return map[mimeType.toLowerCase()] || 'bin';
}

async function resolveLibraryAsset(asset) {
    const declaredMime = asset.mimeType || 'application/octet-stream';

    if (asset.dataUri) {
        const decoded = decodeDataUri(asset.dataUri);
        if (!decoded) throw new Error('Invalid data URI supplied for library asset.');
        return decoded;
    }

    if (asset.base64) {
        return { buffer: Buffer.from(asset.base64, 'base64'), mimeType: declaredMime };
    }

    if (typeof asset.text === 'string') {
        return { buffer: Buffer.from(asset.text, 'utf8'), mimeType: declaredMime === 'application/octet-stream' ? 'text/plain' : declaredMime };
    }

    if (asset.sourceUrl) {
        if (asset.sourceUrl.startsWith('gs://')) {
            const withoutScheme = asset.sourceUrl.slice(5);
            const slash = withoutScheme.indexOf('/');
            if (slash <= 0) throw new Error('Invalid Google Cloud Storage URI.');
            const sourceBucket = withoutScheme.slice(0, slash);
            const sourceName = withoutScheme.slice(slash + 1);
            const [buffer] = await storage.bucket(sourceBucket).file(sourceName).download();
            return { buffer, mimeType: declaredMime };
        }

        const response = await fetch(asset.sourceUrl);
        if (!response.ok) throw new Error(`Could not fetch generated asset (${response.status}).`);
        const arrayBuffer = await response.arrayBuffer();
        return {
            buffer: Buffer.from(arrayBuffer),
            mimeType: response.headers.get('content-type')?.split(';')[0] || declaredMime
        };
    }

    throw new Error('Library asset did not contain dataUri, base64, text, or sourceUrl.');
}

async function saveLibraryAsset(asset) {
    const resolved = await resolveLibraryAsset(asset);
    const mimeType = asset.mimeType || resolved.mimeType || 'application/octet-stream';
    const category = asset.category || 'Reports';
    const baseName = String(asset.name || `${category}-asset`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const extension = baseName.includes('.') ? '' : `.${extensionForMime(mimeType)}`;
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${baseName}${extension}`;
    
    // Save the physical file locally to disk (bypasses Firestore's 1MB limit completely)
    const libraryDir = path.join(process.cwd(), 'uploads', 'library');
    if (!fs.existsSync(libraryDir)) {
        fs.mkdirSync(libraryDir, { recursive: true });
    }
    const localFilePath = path.join(libraryDir, fileName);
    fs.writeFileSync(localFilePath, resolved.buffer);

    // Save only lightweight metadata to Firestore (< 1 KB)
    const record = {
        name: baseName,
        category,
        mimeType,
        fileName,
        localPath: localFilePath,
        size: resolved.buffer.length,
        prompt: asset.prompt || '',
        sourceTab: asset.sourceTab || '',
        createdAt: new Date().toISOString()
    };

    const docRef = await MediaLibrary.add(record);

    return {
        id: docRef.id,
        ...record,
        downloadUrl: `/api/library/${docRef.id}/download`,
        previewUrl: `/api/library/${docRef.id}/preview`
    };
}

// ==========================================
// ENTERPRISE GCS UPLOAD HELPER
// ==========================================
async function uploadToGCS(filePath, originalName, mimeType) {
    // Sanitize filename to prevent URI errors
    const safeName = originalName.replace(/[^a-zA-Z0-9.]/g, '_');
    const destFileName = `${Date.now()}-${safeName}`;
    console.log(`Streaming ${destFileName} directly to GCS bucket...`);
    
    await storage.bucket(BUCKET_NAME).upload(filePath, {
        destination: destFileName,
        metadata: { contentType: mimeType },
    });
    
    const gcsUri = `gs://${BUCKET_NAME}/${destFileName}`;
    console.log(`Upload complete: ${gcsUri}`);
    return { gcsUri, destFileName };
}

// Cleanup Helper
async function deleteFromGCS(destFileName) {
    try {
        await storage.bucket(BUCKET_NAME).file(destFileName).delete();
        console.log(`Cleaned up ${destFileName} from GCS.`);
    } catch (e) {
        console.error(`Failed to delete ${destFileName} from GCS:`, e.message);
    }
}

// ==========================================
// UNIFIED MASTER SUITE AUDIT ENDPOINT
// ==========================================
app.post('/api/audit-master', upload.fields([
    { name: 'script', maxCount: 1 },
    { name: 'video', maxCount: 1 }
]), async (req, res) => {
    
    let gcsScript = null;
    let gcsVideo = null;

    try {
        console.log("Incoming audit request received...");
        const scriptFile = req.files['script'] ? req.files['script'][0] : null;
        const videoFile = req.files['video'] ? req.files['video'][0] : null;

        let contents = [
            `You are the CineMatch AI Master Suite, an elite Hollywood script supervisor and continuity auditor. 
            I am providing a script and a raw video take. 
            Thoroughly analyze both the text and the video. Look for prop switches, hand position changes, background glitches, lighting shifts, and wardrobe inconsistencies between the script's intent and the video's execution.
            
            Write a comprehensive, highly detailed, and professional audit report in Markdown format. 
            Do NOT use JSON. Use clear headings, bullet points, and bold text.
            Structure your report with:
            - OVERALL STATUS (Pass, Warning, or Critical)
            - EXECUTIVE SUMMARY
            - HIGH SEVERITY FLAGS (Critical continuity errors)
            - MEDIUM SEVERITY FLAGS (Minor visual glitches)
            - LOW SEVERITY FLAGS (Suggestions for the director)`
        ];

        if (scriptFile) {
            const upload = await uploadToGCS(scriptFile.path, scriptFile.originalname, scriptFile.mimetype);
            gcsScript = upload.destFileName;
            contents.push("Script PDF:", { fileData: { fileUri: upload.gcsUri, mimeType: scriptFile.mimetype }});
        }

        if (videoFile) {
            const upload = await uploadToGCS(videoFile.path, videoFile.originalname, videoFile.mimetype);
            gcsVideo = upload.destFileName;
            contents.push("Video Take:", { fileData: { fileUri: upload.gcsUri, mimeType: videoFile.mimetype }});
        }

        console.log("Sending payload to Vertex AI model (gemini-3.6-flash)...");
        const response = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: contents
        });

        // Cleanup
        if (scriptFile && fs.existsSync(scriptFile.path)) fs.unlinkSync(scriptFile.path);
        if (videoFile && fs.existsSync(videoFile.path)) fs.unlinkSync(videoFile.path);
        if (gcsScript) await deleteFromGCS(gcsScript);
        if (gcsVideo) await deleteFromGCS(gcsVideo);

        console.log("Audit successfully completed and sent to frontend!");
        res.json({ success: true, report: response.text });

    } catch (error) {
        console.error("Master Audit Error Details:", error);
        
        const scriptFile = req.files && req.files['script'] ? req.files['script'][0] : null;
        const videoFile = req.files && req.files['video'] ? req.files['video'][0] : null;
        if (scriptFile && fs.existsSync(scriptFile.path)) fs.unlinkSync(scriptFile.path);
        if (videoFile && fs.existsSync(videoFile.path)) fs.unlinkSync(videoFile.path);
        if (gcsScript) await deleteFromGCS(gcsScript);
        if (gcsVideo) await deleteFromGCS(gcsVideo);

        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// FEATURE 1: VISUAL CONTINUITY GRAPH ENGINE
// ==========================================
app.post('/api/continuity-audit', upload.fields([
    { name: 'script', maxCount: 1 },
    { name: 'video', maxCount: 1 }
]), async (req, res) => {
    let gcsScript = null;
    let gcsVideo = null;

    try {
        console.log("Generating visual Continuity Graph...");
        const scriptFile = req.files['script'] ? req.files['script'][0] : null;
        const videoFile = req.files['video'] ? req.files['video'][0] : null;

        let contents = [
            `You are the CineMatch AI Master Suite, an elite Hollywood script supervisor and continuity auditor. 
            I am providing a script and a raw video take. 
            Thoroughly analyze both the text and the video. Look for prop switches, hand position changes, background glitches, lighting shifts, and wardrobe inconsistencies.

            Before you write your text report, you MUST output a visual state node graph mapping the scene's continuity elements using Mermaid.js syntax.
            Format the Mermaid block EXACTLY like this:
            \`\`\`mermaid
            graph TD
                Scene --> Location[Setting]
                Scene --> Time[Time of Day]
                Character --> State[Character State/Wardrobe]
                StateMatch --> Check{Consistent?}
                Check -->|Yes| Pass[Pass State]
                Check -->|No| Error[Error Details]
            \`\`\`
            
            Immediately following the Mermaid block, write a comprehensive, highly detailed, and professional audit report in Markdown format. 
            Do NOT use JSON. Use clear headings, bullet points, and bold text.
            Structure your report exactly with:
            - OVERALL STATUS (Pass, Warning, or Critical)
            - EXECUTIVE SUMMARY
            - HIGH SEVERITY FLAGS (Critical continuity errors)
            - MEDIUM SEVERITY FLAGS (Minor visual glitches)
            - LOW SEVERITY FLAGS (Suggestions for the director)`
        ];

        if (scriptFile) {
            const upload = await uploadToGCS(scriptFile.path, scriptFile.originalname, scriptFile.mimetype);
            gcsScript = upload.destFileName;
            contents.push("Script PDF:", { fileData: { fileUri: upload.gcsUri, mimeType: scriptFile.mimetype }});
        }
        if (videoFile) {
            const upload = await uploadToGCS(videoFile.path, videoFile.originalname, videoFile.mimetype);
            gcsVideo = upload.destFileName;
            contents.push("Video Take:", { fileData: { fileUri: upload.gcsUri, mimeType: videoFile.mimetype }});
        }

        const response = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: contents
        });

        if (scriptFile && fs.existsSync(scriptFile.path)) fs.unlinkSync(scriptFile.path);
        if (videoFile && fs.existsSync(videoFile.path)) fs.unlinkSync(videoFile.path);
        if (gcsScript) await deleteFromGCS(gcsScript);
        if (gcsVideo) await deleteFromGCS(gcsVideo);

        res.json({ success: true, report: response.text });
    } catch (error) {
        console.error("Continuity Graph Error:", error);
        
        const scriptFile = req.files && req.files['script'] ? req.files['script'][0] : null;
        const videoFile = req.files && req.files['video'] ? req.files['video'][0] : null;
        if (scriptFile && fs.existsSync(scriptFile.path)) fs.unlinkSync(scriptFile.path);
        if (videoFile && fs.existsSync(videoFile.path)) fs.unlinkSync(videoFile.path);
        if (gcsScript) await deleteFromGCS(gcsScript);
        if (gcsVideo) await deleteFromGCS(gcsVideo);

        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// FEATURE 2: DIFFERENTIAL SUITE (TAKE A vs TAKE B)
// ==========================================
app.post('/api/compare-takes', upload.fields([
    { name: 'takeA', maxCount: 1 },
    { name: 'takeB', maxCount: 1 }
]), async (req, res) => {
    let gcsFileA = null;
    let gcsFileB = null;

    try {
        console.log("Incoming differential comparison request...");
        const takeA = req.files['takeA'] ? req.files['takeA'][0] : null;
        const takeB = req.files['takeB'] ? req.files['takeB'][0] : null;

        if (!takeA || !takeB) {
            return res.status(400).json({ success: false, error: "Both Take A and Take B are required." });
        }

        const uploadA = await uploadToGCS(takeA.path, takeA.originalname, takeA.mimetype);
        gcsFileA = uploadA.destFileName;
        
        const uploadB = await uploadToGCS(takeB.path, takeB.originalname, takeB.mimetype);
        gcsFileB = uploadB.destFileName;

        let contents = [
            `You are the CineMatch AI Master Differential Suite, operating at the highest tier of Hollywood post-production. 
            I am providing two video files: Take A and Take B. Watch and listen to both with extreme precision.
            
            Conduct a relentless, 20-point comparative analysis across five core cinematic domains. 
            Output a highly detailed, professional Markdown report using clear tables, bold text, and structured headings. Do NOT use JSON.

            ### 1. 📐 SPATIAL & GEOMETRIC CONTINUITY
            Use a Markdown table (Columns: Element | Take A | Take B | Status ✓/⚠️/❌) to compare:
            1. **Actor Blocking:** Exact positioning, posture, and weight distribution.
            2. **Prop Tracking:** Placement, grip, and hand-switches of any objects.
            3. **Wardrobe Integrity:** Fabric folds, collar positions, and accessory physics.
            4. **Eyeline Matching:** Gaze trajectory and focal points.
            
            ### 2. 💡 PHOTOMETRIC & LIGHTING DELTA
            Use a Markdown table to compare:
            5. **Exposure Variance:** Shifts in global brightness or aperture f-stops.
            6. **Color Temperature:** Kelvin shifts (cooler/warmer) between takes.
            7. **Shadow Trajectory:** Angle, softness, and depth of cast shadows.
            8. **Specular Highlights:** Reflections on skin, eyes, or metallic props.

            ### 3. 🎭 TALENT & PERFORMANCE ANALYSIS
            Use bullet points to compare:
            9. **Micro-Expressions:** Subtle shifts in facial tension, blinking rates, or micro-reactions.
            10. **Vocal Cadence:** Delivery speed, breath control, and dramatic pauses.
            11. **Dialogue Fidelity:** Deviations from the script, ad-libs, or dropped syllables.
            12. **Kinematic Sync:** The timing of physical gestures relative to spoken dialogue.

            ### 4. 🎛️ ACOUSTIC & AUDIO ENVIRONMENT
            Use bullet points to compare:
            13. **Noise Floor:** Background room tone or ambient hum inconsistencies.
            14. **Audio Peaking:** Dialogue clipping or aggressive volume spikes.
            15. **Reverb Profiles:** Changes in acoustic bounce (indicating mic distance shifts).
            16. **Foley Intrusions:** Unwanted rustling, footsteps, or off-camera noise.

            ### 5. 🎞️ VFX & EDITING READINESS
            Use a Markdown table to compare:
            17. **Camera Stability:** Handheld jitter vs. tripod lockdown drift.
            18. **Depth of Field:** Focus pulling accuracy and background blur consistency.
            19. **Motion Blur:** Shutter angle artifacts during fast movement.
            20. **Background Plate:** Unwanted movement in the background (extras, cars, wind).

            ---
            ### 🎬 THE EXECUTIVE CUT RECOMMENDATION
            Based strictly on the 20 points above, mathematically weigh the technical flaws vs. performance strengths. 
            Deliver a definitive "Director's Select" verdict indicating exactly which take should be sent to the timeline, and explicitly why.`
        ];

        contents.push("Take A Video:", { fileData: { fileUri: uploadA.gcsUri, mimeType: takeA.mimetype }});
        contents.push("Take B Video:", { fileData: { fileUri: uploadB.gcsUri, mimeType: takeB.mimetype }});

        console.log("Analyzing Takes via Vertex AI...");
        const response = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: contents
        });

        if (fs.existsSync(takeA.path)) fs.unlinkSync(takeA.path);
        if (fs.existsSync(takeB.path)) fs.unlinkSync(takeB.path);
        if (gcsFileA) await deleteFromGCS(gcsFileA);
        if (gcsFileB) await deleteFromGCS(gcsFileB);

        console.log("Differential comparison successfully completed!");
        res.json({ success: true, report: response.text });

    } catch (error) {
        console.error("Differential Suite Error:", error);
        if (req.files && req.files['takeA'] && fs.existsSync(req.files['takeA'][0].path)) fs.unlinkSync(req.files['takeA'][0].path);
        if (req.files && req.files['takeB'] && fs.existsSync(req.files['takeB'][0].path)) fs.unlinkSync(req.files['takeB'][0].path);
        if (gcsFileA) await deleteFromGCS(gcsFileA);
        if (gcsFileB) await deleteFromGCS(gcsFileB);

        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// RAG HELPER: COSINE SIMILARITY MATH
// ==========================================
function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += Math.pow(vecA[i], 2);
        normB += Math.pow(vecB[i], 2);
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ==========================================
// FEATURE 3: NARRATIVE MEMORY ENGINE (VECTOR RAG)
// ==========================================
app.post('/api/movie-memory', upload.fields([
    { name: 'script', maxCount: 1 },
    { name: 'videos', maxCount: 5 }
]), async (req, res) => {
    let gcsScript = null;
    let gcsVideos = [];

    try {
        console.log("Incoming Vector RAG Narrative Memory request...");
        const scriptFile = req.files['script'] ? req.files['script'][0] : null;
        const videoFiles = req.files['videos'] || [];

        let scriptChunks = [];
        if (scriptFile) {
            // STEP 1: UPLOAD & CHUNK SCRIPT
            console.log("RAG Phase 1: Parsing PDF Script into semantic chunks...");
            const uploadScript = await uploadToGCS(scriptFile.path, scriptFile.originalname, scriptFile.mimetype);
            gcsScript = uploadScript.destFileName;

            const chunkingPrompt = `You are a script parser. Read this PDF and break it down into an array of scenes. 
            Return STRICTLY a JSON array of strings. Each string must be a full scene (Scene Heading, Action, Dialogue). Do not use markdown blocks, just return the raw JSON array.`;
            
            const chunkRes = await ai.models.generateContent({
                model: 'gemini-3.6-flash',
                contents: [chunkingPrompt, { fileData: { fileUri: uploadScript.gcsUri, mimeType: scriptFile.mimetype } }],
                config: { responseMimeType: "application/json" }
            });
            scriptChunks = JSON.parse(chunkRes.text);
            console.log(`Generated ${scriptChunks.length} semantic scene chunks.`);
        }

        // STEP 2: GENERATE EMBEDDINGS (THE VECTOR STORE)
        console.log("RAG Phase 2: Generating Dense Vector Embeddings...");
        const vectorStore = [];
        for (const chunk of scriptChunks) {
            try {
                const embedRes = await ai.models.embedContent({
                    model: 'text-embedding-004',
                    contents: chunk
                });
                vectorStore.push({
                    text: chunk,
                    vector: embedRes.embeddings[0].values
                });
            } catch (e) {
                console.warn("Failed to embed chunk, skipping...");
            }
        }
        console.log(`Successfully embedded ${vectorStore.length} chunks into memory.`);

        // STEP 3: EMBED QUERY & RETRIEVE
        console.log("RAG Phase 3: Semantic Vector Retrieval...");
        const retrievedContexts = [];

        for (let i = 0; i < videoFiles.length; i++) {
            const file = videoFiles[i];
            const uploadVid = await uploadToGCS(file.path, file.originalname, file.mimetype);
            gcsVideos.push(uploadVid.destFileName);
            
            // 3A. Summarize the video visually
            const vidSummaryRes = await ai.models.generateContent({
                model: 'gemini-3.6-flash',
                contents: ["Describe the exact action, characters, and environment in this video in 2 detailed sentences.", { fileData: { fileUri: uploadVid.gcsUri, mimeType: file.mimetype } }]
            });
            const videoSummary = vidSummaryRes.text;
            console.log(`Video ${i+1} Summary:`, videoSummary);

            // 3B. Generate Query Vector
            if (vectorStore.length > 0) {
                const queryRes = await ai.models.embedContent({
                    model: 'text-embedding-004',
                    contents: videoSummary
                });
                const queryVector = queryRes.embeddings[0].values;

                // 3C. Cosine Similarity Math
                const scoredChunks = vectorStore.map(doc => ({
                    ...doc,
                    score: cosineSimilarity(queryVector, doc.vector)
                })).sort((a, b) => b.score - a.score);

                const bestMatch = scoredChunks[0];
                console.log(`Retrieved best script match for Video ${i+1} with confidence ${bestMatch.score.toFixed(3)}`);
                retrievedContexts.push(`--- RAG RETRIEVED SCRIPT CONTEXT FOR VIDEO ${i+1} ---\n${bestMatch.text}`);
            }
        }

        // STEP 4: AUGMENTED GENERATION (The "G" in RAG)
        console.log("RAG Phase 4: Final Augmented Generation...");
        let finalContents = [
            `You are the CineMatch AI Macro-Continuity Engine.
            Instead of reading a 100-page script, our Vector Search system has retrieved the exact semantic scene matches for the provided video takes.

            ${retrievedContexts.join('\n\n')}

            Your job is to track macro-continuity, object persistence, and narrative logic between the written script matches and the video execution.
            
            Before you write your text report, you MUST output a visual narrative state node graph using Mermaid.js syntax to map the timeline logic.
            Format the Mermaid block EXACTLY like this:
            \`\`\`mermaid
            graph TD
                Scene1[Scene 1] --> State1[Initial Prop/Character State]
                Scene2[Scene 2] --> State2[Evolved State]
                State1 -->|Time/Action Passage| State2
                Check{Narrative Logic Align?}
                State2 --> Check
                Check -->|Yes| Safe[Continuity Maintained]
                Check -->|No| PlotHole[🚨 Macro-Conflict Detected]
            \`\`\`

            Immediately following the Mermaid block, conduct a ruthless 10-point macro-continuity audit. Output a highly detailed, professional Markdown report. Do NOT use JSON. Use clear headings, bullet points, and bold text.`
        ];

        // Attach video files back into the final multimodal call
        for (let i = 0; i < gcsVideos.length; i++) {
            finalContents.push(`Video Take ${i + 1}:`, { fileData: { fileUri: `gs://${BUCKET_NAME}/${gcsVideos[i]}`, mimeType: videoFiles[i].mimetype } });
        }

        const response = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: finalContents
        });

        // Cleanup
        if (scriptFile && fs.existsSync(scriptFile.path)) fs.unlinkSync(scriptFile.path);
        videoFiles.forEach(file => { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); });
        if (gcsScript) await deleteFromGCS(gcsScript);
        for (const name of gcsVideos) await deleteFromGCS(name);

        console.log("Narrative Memory Vector RAG scan complete!");
        res.json({ success: true, report: response.text });

    } catch (error) {
        console.error("Narrative Memory RAG Error:", error);
        
        if (req.files && req.files['script'] && fs.existsSync(req.files['script'][0].path)) fs.unlinkSync(req.files['script'][0].path);
        if (req.files && req.files['videos']) {
            req.files['videos'].forEach(file => { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); });
        }
        if (gcsScript) await deleteFromGCS(gcsScript);
        for (const name of gcsVideos) await deleteFromGCS(name);

        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// FEATURE 4: CHARACTER STATE TRACKING
// ==========================================
app.post('/api/character-state', upload.array('videos', 5), async (req, res) => {
    let gcsVideos = [];

    try {
        console.log("Incoming Character State Tracking request...");
        const videoFiles = req.files || [];

        if (videoFiles.length === 0) {
            return res.status(400).json({ success: false, error: "Please upload at least one video." });
        }

        let contents = [
            `You are the CineMatch AI Lead Character & VFX Supervisor for a massive Hollywood blockbuster. 
            I am providing consecutive video scenes. Create a hyper-detailed, 12-point permanent state log for every major character.
            
            Output a professional Markdown report (No JSON) tracking the following 12 vectors...`
        ];

        for (let i = 0; i < videoFiles.length; i++) {
            const file = videoFiles[i];
            const upload = await uploadToGCS(file.path, file.originalname, file.mimetype);
            gcsVideos.push(upload.destFileName);
            contents.push(`Scene ${i + 1}:`, { fileData: { fileUri: upload.gcsUri, mimeType: file.mimetype }});
        }

        const response = await ai.models.generateContent({ model: 'gemini-3.6-flash', contents: contents });
        
        videoFiles.forEach(file => fs.existsSync(file.path) && fs.unlinkSync(file.path));
        for (const name of gcsVideos) await deleteFromGCS(name);

        res.json({ success: true, report: response.text });
    } catch (error) {
        if (req.files) req.files.forEach(file => fs.existsSync(file.path) && fs.unlinkSync(file.path));
        for (const name of gcsVideos) await deleteFromGCS(name);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// FEATURE 5: SCENE SPATIAL MEMORY
// ==========================================
app.post('/api/spatial-memory', upload.array('videos', 5), async (req, res) => {
    let gcsVideos = [];

    try {
        console.log("Incoming Scene Spatial Memory request...");
        const videoFiles = req.files || [];

        let contents = [
            `You are the CineMatch AI Environment & Volume Supervisor. 
            Your job is to act as a Master CGI Compositor, ensuring the background plates, physical sets, and prop topographies remain flawless across cuts.
            
            Output a highly detailed Markdown report (No JSON) mapping the geography of the scene...`
        ];

        for (let i = 0; i < videoFiles.length; i++) {
            const file = videoFiles[i];
            const upload = await uploadToGCS(file.path, file.originalname, file.mimetype);
            gcsVideos.push(upload.destFileName);
            contents.push(`Shot ${i + 1}:`, { fileData: { fileUri: upload.gcsUri, mimeType: file.mimetype }});
        }

        const response = await ai.models.generateContent({ model: 'gemini-3.6-flash', contents: contents });
        
        videoFiles.forEach(file => fs.existsSync(file.path) && fs.unlinkSync(file.path));
        for (const name of gcsVideos) await deleteFromGCS(name);

        res.json({ success: true, report: response.text });
    } catch (error) {
        if (req.files) req.files.forEach(file => fs.existsSync(file.path) && fs.unlinkSync(file.path));
        for (const name of gcsVideos) await deleteFromGCS(name);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// FEATURE 6: CAMERA CONTINUITY AUDITOR
// ==========================================
app.post('/api/camera-auditor', upload.array('videos', 5), async (req, res) => {
    let gcsVideos = [];

    try {
        console.log("Incoming Camera Continuity Auditor request...");
        const videoFiles = req.files || [];

        let contents = [
            `You are the CineMatch AI Master Cinematographer (Director of Photography). 
            Analyze the camera mechanics, lighting rigs, and lens characteristics between the provided shots.
            
            Output a professional Markdown report (No JSON) evaluating the cinematography across 12 distinct vectors...`
        ];

        for (let i = 0; i < videoFiles.length; i++) {
            const file = videoFiles[i];
            const upload = await uploadToGCS(file.path, file.originalname, file.mimetype);
            gcsVideos.push(upload.destFileName);
            contents.push(`Shot ${i + 1}:`, { fileData: { fileUri: upload.gcsUri, mimeType: file.mimetype }});
        }

        const response = await ai.models.generateContent({ model: 'gemini-3.6-flash', contents: contents });
        
        videoFiles.forEach(file => fs.existsSync(file.path) && fs.unlinkSync(file.path));
        for (const name of gcsVideos) await deleteFromGCS(name);

        res.json({ success: true, report: response.text });
    } catch (error) {
        if (req.files) req.files.forEach(file => fs.existsSync(file.path) && fs.unlinkSync(file.path));
        for (const name of gcsVideos) await deleteFromGCS(name);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// RAW PCM TO WAV CONVERTER (For Gemini TTS)
// ==========================================
function addWavHeader(pcmBuffer, sampleRate = 24000, numChannels = 1, bitDepth = 16) {
    const dataSize = pcmBuffer.length;
    const header = Buffer.alloc(44);
    
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM format
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE((sampleRate * numChannels * bitDepth) / 8, 28);
    header.writeUInt16LE((numChannels * bitDepth) / 8, 32);
    header.writeUInt16LE(bitDepth, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    
    return Buffer.concat([header, pcmBuffer]);
}

// ==========================================
// FEATURE 7: PRE-VIS & STORYBOARD GENERATOR (WITH NATIVE TTS)
// ==========================================
app.post('/api/generate-storyboard', upload.none(), async (req, res) => {
    try {
        console.log("Incoming Storyboard Generation request...");
        const { sceneDescription } = req.body;

        if (!sceneDescription) {
            return res.status(400).json({ success: false, error: "Please provide a scene description." });
        }

        console.log("Agentic DP upgrading the visual prompt...");
        const promptEnhancer = `You are a Master Cinematographer and Concept Artist. 
        Convert the following basic scene description into a highly detailed image generation prompt. 
        Specify the camera angle, lens mm, lighting (e.g., volumetric, chiaroscuro, cinematic), color grading, and atmosphere. 
        Keep it under 60 words, highly descriptive, and comma-separated. Do not include introductory text, just the prompt itself.
        Ensure you append "16:9 cinematic aspect ratio" at the very end.
        
        Scene Description: ${sceneDescription}`;

        const textResponse = await ai.models.generateContent({ 
            model: 'gemini-3.6-flash', 
            contents: promptEnhancer 
        });
        
        const enhancedPrompt = textResponse.text.trim();
        console.log("Enhanced Prompt:", enhancedPrompt);

        const imagenAi = new GoogleGenAI({
            project: 'project-051c2796-a8db-43d9-99c',
            location: 'us-central1',
            vertexai: {
                project: 'project-051c2796-a8db-43d9-99c',
                location: 'us-central1'
            }
        });

        // 1. Generate Image (Imagen 3)
        console.log("Generating 16:9 Pre-Vis Frame...");
        const imagePromise = imagenAi.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: enhancedPrompt,
            config: { responseModalities: ["IMAGE"] }
        });

        // 2. Generate Audio Voiceover (Gemini 3.1 Flash TTS)
        console.log("Generating Voiceover Audio via Gemini TTS...");
        // 2. Generate Audio Voiceover (Agentic Chain: Screenwriter -> Voice Actor)
        const audioPromise = (async () => {
            console.log("Agentic Chain: Writing trailer script...");
            
            // Step A: Screenwriter Agent
            const scriptResponse = await ai.models.generateContent({
                model: 'gemini-3.6-flash',
                contents: `You are an epic movie trailer voiceover artist. Write a dramatic, 6-sentence movie trailer narration (e.g., "In a world...") based on this scene context: ${sceneDescription}. 
                Output ONLY the spoken words. Do not include quotation marks, camera angles, or stage directions.`
            });
            
            const trailerScript = scriptResponse.text.trim();
            console.log("Generated Voiceover Script:", trailerScript);

            // Step B: Voice Actor Agent (TTS)
            console.log("Agentic Chain: Rendering audio via Gemini TTS...");
            return imagenAi.models.generateContent({
                model: 'gemini-3.1-flash-tts-preview',
                contents: trailerScript,
                config: {
                    responseModalities: ["AUDIO"],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: {
                                voiceName: "Charon" 
                            }
                        }
                    }
                }
            });
        })().catch(err => {
            console.warn("TTS generation skipped/failed:", err.message);
            return null;
        });

        // Execute both generative models concurrently
        const [imageResponse, audioResponse] = await Promise.all([imagePromise, audioPromise]);

        const base64Image = imageResponse.candidates[0].content.parts[0].inlineData.data;
        let base64Audio = null;

        // Extract the base64 audio string if the TTS generation succeeded
        // Extract raw PCM bytes and attach a playable WAV header
        if (audioResponse?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data) {
            const rawPcmBase64 = audioResponse.candidates[0].content.parts[0].inlineData.data;
            const pcmBuffer = Buffer.from(rawPcmBase64, 'base64');
            const wavBuffer = addWavHeader(pcmBuffer);
            base64Audio = wavBuffer.toString('base64');
        }

        console.log("Storyboard & Voiceover successfully generated!");
        res.json({ 
            success: true, 
            promptUsed: enhancedPrompt, 
            imageBytes: base64Image,
            audioBytes: base64Audio // Inject the audio payload to the frontend
        });

    } catch (error) {
        console.error("Storyboard Generation Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// FEATURE 8: AUDIO CONTINUITY AGENT
// ==========================================
app.post('/api/audio-continuity', upload.single('audioTake'), async (req, res) => {
    let gcsAudio = null;

    try {
        console.log("Incoming Audio Continuity analysis...");
        const { scriptText, sceneContext } = req.body;
        const audioFile = req.file;

        if (!audioFile || !scriptText) {
            return res.status(400).json({ success: false, error: "Missing audio file or script text." });
        }

        const upload = await uploadToGCS(audioFile.path, audioFile.originalname, audioFile.mimetype);
        gcsAudio = upload.destFileName;

        const prompt = `You are a master Audio Continuity Agent for a film production. 
        Listen carefully to the provided audio take and compare it against the official script.
        
        Official Script: "${scriptText}"
        Scene Context: "${sceneContext}"

        CRITICAL INSTRUCTIONS:
        1. First, evaluate the audio file. If the audio does NOT contain human speech (e.g., it is just music, heavy bass, or silence), you must immediately fail the dialogue match.
        2. Do not invent or hallucinate speech if there is none.

        Analyze and return a strictly formatted JSON object with the following keys:
        1. "dialogueMatch": Boolean (true ONLY if there is human speech that exactly matches the script. false if deviated, or if NO speech is present).
        2. "dialogueNotes": String (Detail any missing lines/mismatches. If it is just music/noise, explicitly state: "CRITICAL ERROR: No human speech detected in the audio file. Detected [insert what you hear, e.g., bass music].")
        3. "backgroundNoise": String (Identify what you actually hear in the background, or state what the dominant sound is if it's just a song).
        4. "environmentFlag": Boolean (true if the sounds in the audio contradict the Scene Context).
        5. "voiceConsistency": String (Note voice characteristics, or state "N/A - No voice detected").`;

        const response = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: [
                prompt,
                { fileData: { fileUri: upload.gcsUri, mimeType: audioFile.mimetype } }
            ],
            config: { responseMimeType: "application/json" }
        });

        const analysis = JSON.parse(response.text);
        
        if (fs.existsSync(audioFile.path)) fs.unlinkSync(audioFile.path);
        if (gcsAudio) await deleteFromGCS(gcsAudio);

        console.log("Audio analysis complete.");
        res.json({ success: true, data: analysis });

    } catch (error) {
        console.error("Audio Continuity Error:", error);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        if (gcsAudio) await deleteFromGCS(gcsAudio);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// FEATURE 9: PRODUCTION RISK AGENT
// ==========================================
app.post('/api/production-risk', upload.none(), async (req, res) => {
    try {
        console.log("Evaluating Production Risks...");
        const { currentBudget, sceneRequirements, proposedChange } = req.body;

        // Block empty submissions to prevent AI hallucination
        if (!currentBudget || !sceneRequirements || !proposedChange) {
            return res.status(400).json({ 
                success: false, 
                error: "Missing data. Please provide the current budget, scene requirements, and proposed change." 
            });
        }

        const prompt = `You are a Production Risk Agent for a film studio. 
        Instead of simply stating the budget, reason about the consequences of production changes.

        Current Budget: ${currentBudget}
        Scene Requirements: ${sceneRequirements}
        Proposed Change: ${proposedChange}

        Analyze the logistical and financial impact of this proposed change. 
        Return a JSON object with:
        1. "riskLevel": "Low", "Medium", or "High".
        2. "allocationWarning": String detailing if the scene may exceed current production allocation.
        3. "actionableInsight": String providing a smart alternative (e.g., "Moving Scene 41 to another day could reduce estimated production cost by 11%").`;

        const response = await ai.models.generateContent({ 
            model: 'gemini-3.6-flash', 
            contents: prompt,
            config: { responseMimeType: "application/json" }
        });
        
        res.json({ success: true, data: JSON.parse(response.text) });

    } catch (error) {
        console.error("Production Risk Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});


// ==========================================
// FEATURE 10: FIX BEFORE YOU SHOOT
// ==========================================
const studioSafetyTools = [{
    functionDeclarations: [
        {
            name: "logSafetyRiskAlert",
            description: "Automatically triggers a critical safety alert when hazardous set conditions or unallocated stunt equipment are detected.",
            parameters: {
                type: "OBJECT",
                properties: {
                    hazardType: { 
                        type: "STRING", 
                        description: "The category of hazard, e.g., 'ELECTRICAL_WATER', 'STUNT_EQUIPMENT', 'PYROTECHNICS', 'OVERTIME_FATIGUE'" 
                    },
                    severity: { 
                        type: "STRING", 
                        enum: ["CRITICAL", "HIGH"],
                        description: "Severity level of the risk" 
                    },
                    description: { 
                        type: "STRING", 
                        description: "Detailed description of the hazard and missing protocol" 
                    }
                },
                required: ["hazardType", "severity", "description"]
            }
        }
    ]
}];

// ==========================================
// FEATURE 10: FIX BEFORE YOU SHOOT
// ==========================================
// ... [tool definition above this] ...

app.post('/api/pre-shoot-risk', upload.none(), async (req, res) => {
    try {
        console.log("Running Pre-Shoot AI Audit...");
        const { scriptExcerpt, productionPlan } = req.body;

        // Block empty submissions to prevent AI forced-function hallucination
        if (!scriptExcerpt || !productionPlan) {
            return res.status(400).json({ 
                success: false, 
                error: "Missing data. Please provide both the script excerpt and the production plan." 
            });
        }

        const prompt = `You are an AI Production Prevention System. Your job is to inspect the script and the production plan before the camera rolls to find critical oversights.
        
        SCRIPT: 
        ${scriptExcerpt}

        PRODUCTION PLAN:
        ${productionPlan}

        Compare the narrative requirements in the script against the logistical reality of the production plan. 
        Identify any missing equipment, personnel, or safety issues.
        
        Return a JSON array of objects, where each object represents a specific risk.
        Each object must have:
        1. "severity": "CRITICAL", "WARNING", or "NOTE".
        2. "riskDescription": A precise string (e.g., "Scene 12 requires a wet costume, but no costume duplicate or water equipment has been allocated.").`;

        // Pass the tools array into the config
        const response = await ai.models.generateContent({ 
            model: 'gemini-3.6-flash', 
            contents: prompt,
            config: { 
                responseMimeType: "application/json",
                tools: studioSafetyTools 
            }
        });
        
        const candidate = response.candidates?.[0]?.content?.parts?.[0];

        // 1. Check if Gemini invoked the native safety tool
        if (candidate?.functionCall) {
            const toolCall = candidate.functionCall;
            console.log(`🚨 NATIVE TOOL TRIGGERED: ${toolCall.name}`);
            console.log("Tool Arguments:", toolCall.args);

            // Return the tool invocation result directly to the frontend
            return res.json({ 
                success: true, 
                toolExecuted: toolCall.name,
                risks: [{
                    severity: toolCall.args.severity,
                    riskDescription: `[AUTO-FLAGGED BY SAFETY TOOL] ${toolCall.args.hazardType}: ${toolCall.args.description}`
                }]
            });
        }

        // 2. Standard JSON fallback if no tool was triggered
        res.json({ success: true, risks: JSON.parse(response.text) });

    } catch (error) {
        console.error("Pre-Shoot Risk Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 🧠 THE ORCHESTRATOR: MASTER PRODUCTION OVERVIEW (10-AGENT DOSSIER)
// ==========================================
app.post('/api/analyze-production', upload.fields([
    { name: 'script', maxCount: 1 },
    { name: 'videos', maxCount: 5 }
]), async (req, res) => {
    let gcsScript = null;
    let gcsVideos = [];

    try {
        console.log("Orchestrator initialized. Fanning out to 10 sub-agents sequentially to protect quotas...");
        
        // 1. Upload Assets
        const scriptFile = req.files?.['script'] ? req.files['script'][0] : null;
        const videoFiles = req.files?.['videos'] ? req.files['videos'] : [];
        const fileContents = [];

        if (scriptFile) {
            const upload = await uploadToGCS(scriptFile.path, scriptFile.originalname, scriptFile.mimetype);
            gcsScript = upload.destFileName;
            fileContents.push("Script:", { fileData: { fileUri: upload.gcsUri, mimeType: scriptFile.mimetype }});
        }

        for (let i = 0; i < videoFiles.length; i++) {
            const upload = await uploadToGCS(videoFiles[i].path, videoFiles[i].originalname, videoFiles[i].mimetype);
            gcsVideos.push(upload.destFileName);
            fileContents.push(`Take ${i + 1}:`, { fileData: { fileUri: upload.gcsUri, mimeType: videoFiles[i].mimetype }});
        }

        // 2. SEQUENTIAL EXECUTION (Fixes the 429 Quota Error)
        const sceneRes = await safeAgentCall([...fileContents, `You are the Scene Audit Agent. First, literally describe exactly what you see. Then, evaluate high-level script-to-screen logical continuity. Do not claim files are missing.`], "Scene Audit");
        const takeRes = await safeAgentCall([...fileContents, `You are the Take Compare Agent. First, describe the footage. Then, flag microscopic differences in actor positioning, lighting, and props between the cuts.`], "Take Compare");
        const rollRes = await safeAgentCall([...fileContents, `You are the Narrative Memory Agent. First, describe the footage. Then, evaluate overarching story logic and tracking facts.`], "Narrative Memory");
        const castRes = await safeAgentCall([...fileContents, `You are the Character State Agent. First, describe the people. Then, analyze wardrobe degradation, physical states, and performance continuity.`], "Character State");
        const mapRes = await safeAgentCall([...fileContents, `You are the Spatial Agent. First, describe the location. Then, map specific object placements and geography.`], "Spatial Tracking");
        const lensRes = await safeAgentCall([...fileContents, `You are the Camera Agent. First, describe the camera angles. Then, evaluate framing, eyelines, and 180-degree axis integrity.`], "Camera Auditor");
        const boardRes = await safeAgentCall([...fileContents, `You are the Pre-Vis Agent. Identify what coverage or storyboard frames are missing based on standard cinematic practices.`], "Pre-Vis Coverage");
        const mixRes = await safeAgentCall([...fileContents, `You are the Audio Agent. First, describe the sounds. Then, analyze room tone, dialogue clarity, and clipping.`], "Audio Continuity");
        const sheetRes = await safeAgentCall([...fileContents, `You are the Budget Risk Agent. First, describe the environment. Then, evaluate schedule, overtime, and financial risks implied.`], "Budget Risk");
        const flagRes = await safeAgentCall([...fileContents, `You are the Pre-Shoot Audit Agent. Cross-check the implied production logistics against safety protocols and crew requirements.`], "Pre-Shoot Audit");

        // 3. Detailed Synthesis
        console.log("Synthesizing Full Executive Production Dossier...");
        const synthesisPrompt = `You are the CineMatch AI Master Orchestrator. 
        I am providing you with raw intelligence reports from 10 specialist agents:
        
        --- SCENE AUDIT ---
        ${sceneRes.text}
        
        --- TAKE COMPARE ---
        ${takeRes.text}
        
        --- NARRATIVE MEMORY ---
        ${rollRes.text}
        
        --- CHARACTER STATE ---
        ${castRes.text}
        
        --- SPATIAL MEMORY ---
        ${mapRes.text}
        
        --- CAMERA AUDITOR ---
        ${lensRes.text}
        
        --- PRE-VIS COVERAGE ---
        ${boardRes.text}

        --- AUDIO CONTINUITY ---
        ${mixRes.text}

        --- BUDGET RISK ---
        ${sheetRes.text}

        --- PRE-SHOOT SAFETY ---
        ${flagRes.text}
        
        Synthesize these findings into an Executive Production Dossier. 
        
        Output STRICTLY valid JSON with the following structure:
        {
            "productionHealthScore": (Number 0-100),
            "totalFindings": (Number),
            "totalRisks": (Number),
            "totalDecisions": (Number),
            "sections": [
                {
                    "module": "Continuity Graph Audit",
                    "tabKey": "scene",
                    "status": "PASS" | "WARNING" | "CRITICAL",
                    "footageContext": "10-sentence literal description of the media.",
                    "summary": "Detailed overview evaluating script-to-screen logic.",
                    "findings": ["Observation 1", "Observation 2"]
                },
                {
                    "module": "Take-to-Take Comparison",
                    "tabKey": "take",
                    "status": "PASS" | "WARNING" | "CRITICAL",
                    "footageContext": "10-sentence literal description.",
                    "summary": "Detailed overview of differences between cuts.",
                    "findings": ["Observation 1", "Observation 2"]
                },
                {
                    "module": "Narrative Memory",
                    "tabKey": "roll",
                    "status": "PASS" | "WARNING" | "CRITICAL",
                    "footageContext": "10-sentence literal description.",
                    "summary": "Detailed overview of story logic tracking.",
                    "findings": ["Observation 1", "Observation 2"]
                },
                {
                    "module": "Character State Tracking",
                    "tabKey": "cast",
                    "status": "PASS" | "WARNING" | "CRITICAL",
                    "footageContext": "10-sentence literal description of people.",
                    "summary": "Detailed overview of wardrobe and physical states.",
                    "findings": ["Observation 1", "Observation 2"]
                },
                {
                    "module": "Scene Spatial Memory",
                    "tabKey": "map",
                    "status": "PASS" | "WARNING" | "CRITICAL",
                    "footageContext": "10-sentence literal description of the location.",
                    "summary": "Detailed overview of object placements.",
                    "findings": ["Observation 1", "Observation 2"]
                },
                {
                    "module": "Camera Continuity Auditor",
                    "tabKey": "lens",
                    "status": "PASS" | "WARNING" | "CRITICAL",
                    "footageContext": "10-sentence literal description of camera angles.",
                    "summary": "Detailed overview of framing and axis integrity.",
                    "findings": ["Observation 1", "Observation 2"]
                },
                {
                    "module": "Pre-Vis Storyboard",
                    "tabKey": "board",
                    "status": "PASS" | "WARNING" | "CRITICAL",
                    "footageContext": "Description of existing coverage.",
                    "summary": "Evaluation of missing coverage or needed shots.",
                    "findings": ["Observation 1", "Observation 2"]
                },
                {
                    "module": "Audio Continuity Agent",
                    "tabKey": "mix",
                    "status": "PASS" | "WARNING" | "CRITICAL",
                    "footageContext": "10-sentence description of sound.",
                    "summary": "Overview of dialogue and room tone.",
                    "findings": ["Observation 1", "Observation 2"]
                },
                {
                    "module": "Production Risk Agent",
                    "tabKey": "sheet",
                    "status": "PASS" | "WARNING" | "CRITICAL",
                    "footageContext": "Description of logistical environment.",
                    "summary": "Evaluation of budget and schedule impacts.",
                    "findings": ["Observation 1", "Observation 2"]
                },
                {
                    "module": "Fix Before You Shoot",
                    "tabKey": "flag",
                    "status": "PASS" | "WARNING" | "CRITICAL",
                    "footageContext": "Description of apparent safety parameters.",
                    "summary": "Logistical safety cross-check.",
                    "findings": ["Observation 1", "Observation 2"]
                }
            ]
        }`;

        const finalOverview = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: synthesisPrompt,
            config: { responseMimeType: "application/json" }
        });

        // 4. Parse and Persist
        const dossierData = JSON.parse(finalOverview.text);

        try {
            await AuditHistory.add({
                userId: 'director@cinematch.ai',
                projectName: 'Agentic Cinema Hackathon Demo',
                report: dossierData,
                timestamp: new Date().toISOString()
            });
            console.log('💾 Dossier state successfully persisted to Firebase Firestore.');
        } catch (dbErr) {
            console.error('⚠️ Firestore save error:', dbErr.message);
        }

        // 5. Cleanup
        if (scriptFile && fs.existsSync(scriptFile.path)) fs.unlinkSync(scriptFile.path);
        videoFiles.forEach(file => fs.existsSync(file.path) && fs.unlinkSync(file.path));
        if (gcsScript) await deleteFromGCS(gcsScript);
        for (const name of gcsVideos) await deleteFromGCS(name);

        console.log("Full 10-Agent Dossier generation complete!");
        res.json({ success: true, overview: dossierData });

    } catch (error) {
        console.error("Orchestrator Error:", error);
        if (req.files?.['script'] && fs.existsSync(req.files['script'][0].path)) fs.unlinkSync(req.files['script'][0].path);
        if (req.files?.['videos']) req.files['videos'].forEach(file => fs.existsSync(file.path) && fs.unlinkSync(file.path));
        if (gcsScript) await deleteFromGCS(gcsScript);
        for (const name of gcsVideos) await deleteFromGCS(name);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 🎬 THE PRE-VIS VIDEO AGENT (VERTEX AI VEO + AUDIO)
// ==========================================
app.post('/api/generate-video-previs', upload.fields([
    { name: 'assets', maxCount: 5 }
]), async (req, res) => {
    try {
        console.log("Initializing Vertex AI Pre-Vis Video Generation...");
        const sceneIdea = req.body.sceneDescription || "Cinematic scene";
        
        // 1. Synthesize prompt with explicit audio & visual instructions using Gemini
        const promptAgent = `You are the CineMatch Pre-Vis Agent.
        The director needs a visual and audio pre-visualization for this scene context: "${sceneIdea}"
        
        Write a professional text-to-video prompt (under 50 words) combining:
        [Lighting/Time of Day], [Camera Movement], [Subject Action], [Lens], and [Explicit Sound Effects like thunder, crashing waves, or heavy rain].`;
        
        const promptResult = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: promptAgent
        });
        
        const optimizedVeoPrompt = promptResult.text.trim().replace(/[\n\r]/g, ' ');
        console.log("Optimized Video Prompt:", optimizedVeoPrompt);

        // 2. Execute Real Video Generation via Google Cloud Vertex AI
        const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID || 'project-051c2796-a8db-43d9-99c'; 
        const location = 'us-central1'; 
        
        const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
        const client = await auth.getClient();
        const accessToken = (await client.getAccessToken()).token;

        // Updated to use the standard Veo 3.1 model which includes native audio generation
        const vertexUrl = `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/${location}/publishers/google/models/veo-3.1-generate-001:predictLongRunning`;

        // Step 2A: Submit job with audio generation enabled
        let initResponse;
        let initData;
        let maxRetries = 3;
        let retryDelay = 3000;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            initResponse = await fetch(vertexUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    instances: [
                        { prompt: optimizedVeoPrompt }
                    ],
                    parameters: {
                        aspectRatio: "16:9",
                        fps: 24,
                        durationSeconds: 8, // Max single-pass duration
                        generateAudio: true  // Forces Veo to synthesize matching sound design
                    }
                })
            });

            initData = await initResponse.json();

            if (initData.error && (initData.error.message.includes('high load') || initData.error.code === 429 || initData.error.code === 503)) {
                console.log(`[Attempt ${attempt}/${maxRetries}] Vertex AI busy. Retrying in ${retryDelay / 1000}s...`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                retryDelay *= 2;
            } else {
                break;
            }
        }

        if (initData.error) {
            throw new Error(initData.error.message || "Vertex AI Video Initialization failed.");
        }

        const operationName = initData.name;
        console.log(`Job submitted! Tracking ID: ${operationName}`);

        // Step 2B: Poll the Operation Endpoint using fetchPredictOperation
        const pollUrl = `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/${location}/publishers/google/models/veo-3.1-fast-generate-001:fetchPredictOperation`;
        
        let isDone = false;
        let finalVideoUrl = null;

        while (!isDone) {
            await new Promise(resolve => setTimeout(resolve, 10000));
            
            const pollResponse = await fetch(pollUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ operationName: operationName })
            });
            const pollData = await pollResponse.json();

            if (pollData.error) {
                throw new Error(pollData.error.message || "Error polling video status.");
            }

            if (pollData.done) {
                isDone = true;
                
                // Parse Vertex AI Veo response structure safely
                try {
                    const resp = pollData.response;
                    if (resp?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri) {
                        // If Veo returns a Google Storage URI, fetch it and convert to base64
                        const gcsUri = resp.generateVideoResponse.generatedSamples[0].video.uri;
                        finalVideoUrl = gcsUri; // Or fetch and convert if required by frontend
                    } else if (resp?.videos?.[0]?.bytesBase64Encoded) {
                        finalVideoUrl = `data:video/mp4;base64,${resp.videos[0].bytesBase64Encoded}`;
                    } else if (resp?.predictions?.[0]?.bytesBase64Encoded) {
                        finalVideoUrl = `data:video/mp4;base64,${resp.predictions[0].bytesBase64Encoded}`;
                    } else {
                        // Fallback inspection dump
                        console.log("Full Response Payload:", JSON.stringify(resp, null, 2));
                        throw new Error("Video completed, but video path could not be parsed from response structure.");
                    }
                } catch (parseErr) {
                    throw new Error(`Parsing Error: ${parseErr.message}`);
                }
            } else {
                console.log("Still rendering audio and frames... checking again in 10s.");
            }
        }

        console.log("Vertex AI video & audio generation complete!");

        res.json({ 
            success: true, 
            promptUsed: optimizedVeoPrompt,
            videoUrl: finalVideoUrl 
        });

    } catch (error) {
        console.error("Video Generation Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// SUPPORT DELIVERY HELPERS
// Feedback, bug reports and help requests are always persisted in Firestore.
// If RESEND_API_KEY + SUPPORT_EMAIL are configured, they are also emailed
// immediately to the configured owner inbox. No login is required.
// ==========================================
function cleanSupportText(value, max = 8000) {
    return String(value ?? '').trim().slice(0, max);
}

// Persist an uploaded screenshot to local disk (mirrors the Media Library
// pattern) so it survives even if email delivery isn't configured, and
// return the lightweight metadata that goes in the Firestore record.
function saveSupportAttachment(docId, index, file) {
    const supportDir = path.join(process.cwd(), 'uploads', 'support', docId);
    if (!fs.existsSync(supportDir)) fs.mkdirSync(supportDir, { recursive: true });
    const safeName = String(file.originalname || `screenshot-${index + 1}`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileName = `${index}-${safeName}`;
    fs.writeFileSync(path.join(supportDir, fileName), file.buffer);
    return {
        fileName,
        originalName: file.originalname || safeName,
        mimeType: file.mimetype,
        size: file.size,
        url: `/api/support/${docId}/attachment/${index}`
    };
}

async function deliverSupportEmail(message) {
    const apiKey = process.env.RESEND_API_KEY;
    const to = process.env.SUPPORT_EMAIL;
    if (!apiKey || !to) return { delivered: false, reason: 'email_not_configured' };

    const subjectPrefix = message.type === 'bug' ? '[CineMatch Bug]' : message.type === 'feedback' ? '[CineMatch Feedback]' : '[CineMatch Help]';
    const attachmentsHtml = (message.attachments || []).length
        ? `<p><strong>Screenshots:</strong></p><ul>${(message.attachments || []).map(a => `<li>${htmlEscape(a.originalName)} (${Math.round((a.size || 0) / 1024)} KB) — see attached, or view at ${htmlEscape((process.env.PUBLIC_APP_URL || '') + a.url)}</li>`).join('')}</ul>`
        : '';
    const html = `
        <h2>${subjectPrefix}</h2>
        <p><strong>Category:</strong> ${cleanSupportText(message.category, 120)}</p>
        <p><strong>From:</strong> ${cleanSupportText(message.email, 320) || 'Anonymous'}</p>
        <p><strong>Page:</strong> ${cleanSupportText(message.page, 500)}</p>
        <p><strong>Message:</strong></p>
        <pre style="white-space:pre-wrap;font-family:Arial,sans-serif;">${cleanSupportText(message.message)}</pre>
        ${message.type === 'bug' ? `<p><strong>Steps to reproduce:</strong></p><pre style="white-space:pre-wrap;font-family:Arial,sans-serif;">${cleanSupportText(message.steps || 'Not supplied')}</pre>` : ''}
        ${attachmentsHtml}
        <p style="color:#666;font-size:12px">CineMatch anonymous hackathon workspace · ${new Date().toISOString()}</p>
    `;

    // Attach the raw screenshots directly (Resend accepts base64 content)
    // so the recipient literally receives the images in the email itself.
    const resendAttachments = (message.attachmentFiles || []).map(f => ({
        filename: f.originalname || 'screenshot.png',
        content: f.buffer.toString('base64')
    }));

    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            from: process.env.SUPPORT_FROM_EMAIL || 'CineMatch <onboarding@resend.dev>',
            to: [to],
            reply_to: message.email || undefined,
            subject: `${subjectPrefix} ${cleanSupportText(message.category, 80) || 'New submission'}`,
            html,
            attachments: resendAttachments.length ? resendAttachments : undefined
        })
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => 'Email delivery failed.');
        throw new Error(`Support email delivery failed: ${detail.slice(0, 500)}`);
    }
    const result = await response.json().catch(() => ({}));
    return { delivered: true, providerId: result.id || null };
}

// ==========================================
// PERSISTENT MEDIA LIBRARY API (FIRESTORE + DISK STREAM)
// ==========================================
app.get('/api/library', async (req, res) => {
    try {
        const snapshot = await MediaLibrary.orderBy('createdAt', 'desc').limit(100).get();
        const items = snapshot.docs.map((doc) => {
            const item = { id: doc.id, ...doc.data() };
            item.previewUrl = `/api/library/${doc.id}/preview`;
            item.downloadUrl = `/api/library/${doc.id}/download`;
            return item;
        });
        res.json({ success: true, items });
    } catch (error) {
        console.error('Media Library fetch error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// KEEP THIS EXACTLY AS IS - It handles saving from the frontend!
app.post('/api/library/assets', async (req, res) => {
    try {
        const assets = Array.isArray(req.body?.assets) ? req.body.assets : [];
        if (!assets.length) return res.status(400).json({ success: false, error: 'No library assets supplied.' });
        if (assets.length > 20) return res.status(400).json({ success: false, error: 'Too many library assets in one request.' });

        const saved = [];
        for (const asset of assets) {
            saved.push(await saveLibraryAsset(asset));
        }
        res.json({ success: true, items: saved });
    } catch (error) {
        console.error('Media Library save error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// NEW: Serve preview images directly from local disk
// Delete a saved Media Library output from disk + Firestore.
app.delete('/api/library/:id', async (req, res) => {
    try {
        const docRef = MediaLibrary.doc(req.params.id);
        const snap = await docRef.get();
        if (!snap.exists) return res.status(404).json({ success: false, error: 'Library item not found.' });

        const item = snap.data() || {};
        if (item.localPath && fs.existsSync(item.localPath)) {
            fs.unlinkSync(path.resolve(item.localPath));
        }
        await docRef.delete();
        res.json({ success: true, id: snap.id });
    } catch (error) {
        console.error('Media Library delete error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/library/:id/preview', async (req, res) => {
    try {
        const snap = await MediaLibrary.doc(req.params.id).get();
        if (!snap.exists) return res.status(404).json({ success: false, error: 'Library item not found.' });
        const item = snap.data();
        
        if (item.localPath && fs.existsSync(item.localPath)) {
            res.setHeader('Content-Type', item.mimeType || 'application/octet-stream');
            return res.sendFile(path.resolve(item.localPath));
        }
        return res.status(404).json({ success: false, error: 'File content not found.' });
    } catch (error) {
        console.error('Media Library preview error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// UPDATED: Download directly from local disk
app.get('/api/library/:id/download', async (req, res) => {
    try {
        const snap = await MediaLibrary.doc(req.params.id).get();
        if (!snap.exists) return res.status(404).json({ success: false, error: 'Library item not found.' });
        const item = snap.data();
        
        if (item.localPath && fs.existsSync(item.localPath)) {
            res.setHeader('Content-Type', item.mimeType || 'application/octet-stream');
            return res.download(path.resolve(item.localPath), String(item.name || 'cinematch-asset'));
        }
        return res.status(404).json({ success: false, error: 'File content not found.' });
    } catch (error) {
        console.error('Media Library download error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// SUPPORT CENTER API
// ==========================================
app.post('/api/support', supportUpload.array('attachments', 4), async (req, res) => {
    try {
        const type = ['feedback', 'bug', 'help'].includes(req.body?.type) ? req.body.type : 'help';
        const record = {
            type,
            category: cleanSupportText(req.body?.category, 120),
            email: cleanSupportText(req.body?.email, 320),
            message: cleanSupportText(req.body?.message, 8000),
            steps: cleanSupportText(req.body?.steps, 8000),
            page: cleanSupportText(req.body?.page, 500),
            userAgent: cleanSupportText(req.body?.userAgent, 1000),
            createdAt: new Date().toISOString(),
            status: 'new'
        };

        if (!record.message) {
            return res.status(400).json({ success: false, error: 'Please enter a message.' });
        }

        const docRef = await SupportMessages.add(record);

        const files = Array.isArray(req.files) ? req.files : [];
        const attachments = files.map((file, index) => saveSupportAttachment(docRef.id, index, file));
        if (attachments.length) {
            await docRef.update({ attachments });
        }

        let delivery = { delivered: false, reason: 'email_not_configured' };
        try {
            delivery = await deliverSupportEmail({ ...record, id: docRef.id, attachments, attachmentFiles: files });
            if (delivery.delivered) {
                await docRef.update({ status: 'delivered', deliveryProvider: 'resend', providerId: delivery.providerId || null });
            }
        } catch (mailErr) {
            console.error('Support email delivery error:', mailErr.message);
            await docRef.update({ status: 'saved_email_failed', deliveryError: mailErr.message.slice(0, 500) });
            delivery = { delivered: false, reason: 'email_delivery_failed' };
        }

        res.json({
            success: true,
            id: docRef.id,
            delivered: delivery.delivered,
            attachments: attachments.map(a => ({ originalName: a.originalName, url: a.url })),
            message: delivery.delivered
                ? 'Your message was sent to the CineMatch support inbox.'
                : 'Your message was securely saved. The support inbox email is not configured yet.'
        });
    } catch (error) {
        console.error('Support submission error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Multer errors on this route (file too large, too many files, non-image
// file type) land here instead of crashing the request.
app.use('/api/support', (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        const message = err.code === 'LIMIT_FILE_SIZE'
            ? 'Each screenshot must be under 5MB.'
            : err.code === 'LIMIT_FILE_COUNT'
                ? 'You can attach up to 4 screenshots.'
                : 'Could not process the attached file(s).';
        return res.status(400).json({ success: false, error: message });
    }
    if (err) return res.status(400).json({ success: false, error: err.message || 'Only image files can be attached.' });
    next();
});

app.get('/api/support/:id/attachment/:index', async (req, res) => {
    try {
        const snap = await SupportMessages.doc(req.params.id).get();
        if (!snap.exists) return res.status(404).json({ success: false, error: 'Support message not found.' });
        const item = snap.data();
        const attachment = (item.attachments || [])[Number(req.params.index)];
        if (!attachment) return res.status(404).json({ success: false, error: 'Attachment not found.' });

        const filePath = path.join(process.cwd(), 'uploads', 'support', req.params.id, attachment.fileName);
        if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, error: 'Attachment file not found.' });

        res.setHeader('Content-Type', attachment.mimeType || 'application/octet-stream');
        return res.sendFile(path.resolve(filePath));
    } catch (error) {
        console.error('Support attachment fetch error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// PERSISTENT INTELLIGENCE CHAT HISTORY
// Anonymous hackathon workspace: no login required.
// Stores the History runs for EVERY tool in the suite.
// ==========================================
app.post('/api/intelligence-history', async (req, res) => {
    try {
        const { tabKey, title, meta, summary, responseData } = req.body || {};
        
        // 🚨 FIX: Removed the hardcoded 'allowed' Set. 
        // This endpoint now accepts ALL tools (Intelligence, Studio, and Scouting) 
        // to act as the universal Chat History database.

        const record = {
            tabKey,
            title: String(title || tabKey),
            meta: String(meta || new Date().toLocaleString()),
            summary: String(summary || ''),
            responseData: responseData && typeof responseData === 'object' ? responseData : {},
            timestamp: new Date().toISOString()
        };

        const docRef = await IntelligenceHistory.add(record);
        res.json({ success: true, item: { id: docRef.id, ...record } });
    } catch (error) {
        console.error('Intelligence history save error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// DOWNLOAD A SAVED INTELLIGENCE REPORT
// Generates a standalone, readable HTML report from persisted JSON.
// ==========================================
function htmlEscape(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function reportToHtml(item) {
    const data = item.responseData || {};
    const pretty = JSON.stringify(data, null, 2);
    const summary = item.summary || 'AI analysis completed successfully.';
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>${htmlEscape(item.title || 'CineMatch Intelligence Report')}</title>
<style>body{font-family:Inter,Arial,sans-serif;background:#0b1117;color:#e8eef2;margin:0;padding:40px}main{max-width:900px;margin:auto}header{border-bottom:1px solid #27343d;padding-bottom:22px;margin-bottom:24px}h1{font-size:28px;margin:0 0 8px}h2{font-size:15px;color:#31b8aa;text-transform:uppercase;letter-spacing:.08em;margin-top:30px}p{line-height:1.7;color:#c4d0d8}.meta{font-size:12px;color:#7f909b}pre{white-space:pre-wrap;background:#101820;border:1px solid #27343d;border-radius:10px;padding:18px;line-height:1.55;color:#dce6eb;overflow:auto}.badge{display:inline-block;padding:4px 8px;border:1px solid #315d58;border-radius:999px;color:#31b8aa;font-size:11px}</style></head>
<body><main><header><span class="badge">CineMatch Intelligence</span><h1>${htmlEscape(item.title || 'Intelligence Report')}</h1><div class="meta">${htmlEscape(item.meta || item.timestamp || '')}</div></header><h2>Executive Summary</h2><p>${htmlEscape(summary)}</p><h2>Saved Report Data</h2><pre>${htmlEscape(pretty)}</pre><p class="meta">Generated by CineMatch AI · ${htmlEscape(item.timestamp || new Date().toISOString())}</p></main></body></html>`;
}

app.get('/api/intelligence-history/:id/download', async (req, res) => {
    try {
        const snap = await IntelligenceHistory.doc(req.params.id).get();
        if (!snap.exists) return res.status(404).json({ success: false, error: 'Intelligence report not found.' });
        const item = { id: snap.id, ...snap.data() };
        const safeName = String(item.title || 'intelligence-report').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'intelligence-report';
        
        const htmlContent = reportToHtml(item);
        
        // Handle Word Document generation
        if (req.query.format === 'word') {
            res.setHeader('Content-Type', 'application/msword');
            res.setHeader('Content-Disposition', `attachment; filename="${safeName}-${snap.id.slice(0, 8)}.doc"`);
            return res.send(htmlContent);
        }

        // Standard HTML generation (used internally by our PDF engine)
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}-${snap.id.slice(0, 8)}.html"`);
        res.send(htmlContent);
    } catch (error) {
        console.error('Intelligence report download error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// RENAME AND DELETE INTELLIGENCE CHAT HISTORY
// ==========================================
app.patch('/api/intelligence-history/:id', async (req, res) => {
    try {
        const { title } = req.body;
        if (!title) return res.status(400).json({ success: false, error: 'Title is required' });
        
        await IntelligenceHistory.doc(req.params.id).update({ title: String(title) });
        res.json({ success: true });
    } catch (error) {
        console.error('Error renaming history:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/intelligence-history/:id', async (req, res) => {
    try {
        await IntelligenceHistory.doc(req.params.id).delete();
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting history:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// GET PERSISTENT AUDIT + INTELLIGENCE HISTORY
// ==========================================
app.get('/api/history', async (req, res) => {
    try {
        console.log('Fetching CineMatch history from Firebase...');

        // Keep the existing production dossier query contract intact.
        const auditSnapshot = await AuditHistory
            .where('userId', '==', 'director@cinematch.ai')
            .get();

        const history = auditSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        })).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 20);

        // No composite Firestore index is required; sort in JavaScript.
        const intelligenceSnapshot = await IntelligenceHistory.get();
        const intelligenceHistory = intelligenceSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        })).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 100);

        res.json({ success: true, history, intelligenceHistory });
    } catch (error) {
        console.error('Error fetching CineMatch history from Firestore:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// FEATURE: TIMESTAMPED VIDEO TRANSCRIPTION
// ==========================================
app.post('/api/transcribe-video', upload.single('video'), async (req, res) => {
    let gcsVideo = null;

    try {
        console.log("Incoming video transcription & diarization request...");
        const videoFile = req.file;

        if (!videoFile) {
            return res.status(400).json({ success: false, error: "Please upload a video file." });
        }

        // 1. Upload to GCS
        const upload = await uploadToGCS(videoFile.path, videoFile.originalname, videoFile.mimetype);
        gcsVideo = upload.destFileName;

        // 2. Multimodal Timestamped Transcription & Visual Prompt
        const prompt = `You are the CineMatch AI Master Script Supervisor and Dialogue Editor. 
        Listen to the audio AND watch the video frames simultaneously to generate a frame-accurate, multimodal transcript.

        Strict JSON format requirements:
        Return ONLY a valid JSON object matching this exact structure:
        {
        "sceneSummary": "Brief 2-sentence overview of the narrative and visual environment.",
        "speakersDetected": ["Speaker Name / Role 1", "Speaker Name / Role 2"],
        "transcripts": [
            {
            "timestamp": "MM:SS",
            "seconds": (Integer: total seconds from start, e.g., 14),
            "speaker": "Character / Speaker Name (or 'Ambient/Action' if no one is speaking)",
            "dialogue": "Exact transcribed spoken text. Leave blank if it is purely a visual action beat.",
            "tone": "Vocal tone (e.g., Whispering, Sarcastic, Inspiring)",
            "visualContext": "Describe the camera framing (e.g., Medium Close-Up) and what the subject/environment is physically doing during this exact timestamp.",
            "confidence": "HIGH" | "MEDIUM" | "LOW"
            }
        ]
        }`;

        console.log("Processing audio and video frames via Gemini 3.6 Flash...");
        const response = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: [
                prompt,
                { fileData: { fileUri: upload.gcsUri, mimeType: videoFile.mimetype } }
            ],
            config: {
                responseMimeType: "application/json"
            }
        });

        // 3. Clean up local and bucket storage
        if (fs.existsSync(videoFile.path)) fs.unlinkSync(videoFile.path);
        if (gcsVideo) await deleteFromGCS(gcsVideo);

        const parsedData = JSON.parse(response.text);
        console.log(`Transcription complete: ${parsedData.transcripts?.length || 0} dialogue cues detected.`);

        res.json({ success: true, data: parsedData });

    } catch (error) {
        console.error("Transcription Error:", error);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        if (gcsVideo) await deleteFromGCS(gcsVideo);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// FEATURE 11: MUSIC GENERATION (LYRIA 3) WITH GUARDRAILS
// ==========================================
app.post('/api/generate-music', upload.none(), async (req, res) => {
    try {
        console.log("Incoming Lyria 3 Music Generation request...");
        const { genre, prompt } = req.body;

        if (!genre || !prompt) {
            return res.status(400).json({ success: false, error: "Genre and prompt are required." });
        }

        // STEP 1: Guardrail Check via Gemini 3.6 Flash
        console.log(`Guardrail Check: Validating prompt against '${genre}' genre...`);
        const guardrailPrompt = `You are a music producer guardrail. The user has selected the genre "${genre}", and provided this musical prompt: "${prompt}".
        
        Does the musical prompt severely conflict with the selected genre? (e.g. asking for cheerful upbeat ukulele when the genre is Horror Ambient).
        
        Return ONLY a JSON object with this structure:
        {
          "conflict": boolean,
          "reason": "If conflict is true, provide a 1-sentence explanation of why it conflicts and suggest a fix. If false, leave empty."
        }`;

        const guardrailRes = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: guardrailPrompt,
            config: { responseMimeType: "application/json" }
        });

        const guardrailData = JSON.parse(guardrailRes.text);
        if (guardrailData.conflict) {
            console.warn("Guardrail Triggered:", guardrailData.reason);
            // Return HTTP 400 with a special conflict flag so the UI can format it nicely
            return res.status(400).json({ 
                success: false, 
                conflict: true, 
                error: guardrailData.reason 
            });
        }

        // STEP 2: Execute Lyria 3 via the Gemini Interactions API (us-central1)
        console.log("Validation passed. Generating music via Lyria 3 Preview...");
        
        // Lyria 3 is bound to the us-central1 region, so we initialize a dedicated client
        // Use the 'us' multi-region routing required by the interactions API
        // Lyria 3 Preview is currently restricted to the global location endpoint
        const lyriaAi = new GoogleGenAI({
            project: 'project-051c2796-a8db-43d9-99c',
            location: 'global',
            vertexai: {
                project: 'project-051c2796-a8db-43d9-99c',
                location: 'global'
            }
        });

        const interaction = await lyriaAi.interactions.create({
            model: 'lyria-3-clip-preview',
            input: `${genre} style: ${prompt}`
        });

        let base64Audio = null;
        if (interaction.output_audio && interaction.output_audio.data) {
            base64Audio = interaction.output_audio.data;
        } else {
            throw new Error("Music generation succeeded but audio data was missing from the response.");
        }

        console.log("Music generation complete!");
        res.json({ success: true, audioBase64: base64Audio });

    } catch (error) {
        console.error("Music Generation Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// FEATURE 12: MULTI-SPEAKER PODCAST GENERATOR (EXTENDED)
// ==========================================
app.post('/api/generate-podcast', upload.none(), async (req, res) => {
    try {
        console.log("Incoming Multi-Speaker Podcast request...");
        const { topic } = req.body;

        if (!topic) return res.status(400).json({ success: false, error: "Topic required." });

        // 1. Scriptwriter Agent (Longer, more detailed prompt)
        console.log("Podcast Phase 1: Writing extended script...");
        const scriptRes = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: `Write a deep, engaging, and highly detailed 10-to-12 line podcast deep-dive about "${topic}". 
            The speakers are "Host" and "Guest". Make the conversation dynamic, with dramatic reactions, deep analysis, and expressive dialogue. 
            Return ONLY a JSON array of objects with keys "speaker" and "text". Do not include markdown formatting.`,
            config: { responseMimeType: "application/json" }
        });
        
        const script = JSON.parse(scriptRes.text);
        console.log(`Script generated with ${script.length} lines.`);

        // 2. Multi-Voice TTS Engine (Parallelized for Speed)
        console.log("Podcast Phase 2: Generating multi-voice audio concurrently...");
        
        const imagenAi = new GoogleGenAI({
            project: 'project-051c2796-a8db-43d9-99c',
            location: 'us-central1',
            vertexai: {
                project: 'project-051c2796-a8db-43d9-99c',
                location: 'us-central1'
            }
        });
        
        const voiceMap = { "Host": "Aoede", "Guest": "Charon" }; 

        // Execute all TTS requests simultaneously instead of waiting one-by-one!
        const audioClips = await Promise.all(script.map(async (line) => {
            try {
                const ttsRes = await imagenAi.models.generateContent({
                    model: 'gemini-3.1-flash-tts-preview',
                    contents: line.text,
                    config: {
                        responseModalities: ["AUDIO"],
                        speechConfig: { 
                            voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceMap[line.speaker] || "Puck" } } 
                        }
                    }
                });

                if (ttsRes?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data) {
                    const rawPcmBase64 = ttsRes.candidates[0].content.parts[0].inlineData.data;
                    const pcmBuffer = Buffer.from(rawPcmBase64, 'base64');
                    return {
                        speaker: line.speaker,
                        text: line.text,
                        audioBase64: addWavHeader(pcmBuffer).toString('base64')
                    };
                }
            } catch (err) {
                console.warn(`Audio generation failed for line: "${line.text}"`, err.message);
            }
            return null; // Fallback if a specific line hits a quota error
        }));

        // Filter out any lines that failed to generate
        const validClips = audioClips.filter(clip => clip !== null);

        console.log("Extended multi-speaker podcast complete!");
        res.json({ success: true, clips: validClips });

    } catch (error) {
        console.error("Podcast Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// FEATURE 13: PRODUCTION RISK (MULTIMODAL FORCED FUNCTION CALLING)
// ==========================================
// Note: Changed from upload.none() to upload.single('sceneImage') to accept a visual cue
app.post('/api/visual-production-risk', memoryUpload.single('sceneImage'), async (req, res) => {
    try {
        console.log("Incoming Multimodal Production Risk request...");
        const sceneDescription = req.body.sceneDescription || "Analyze this scene.";
        
        if (!req.file) {
            return res.status(400).json({ success: false, error: "Visual cue (image) is required for safety analysis." });
        }

        // Convert the uploaded image into Gemini's expected inlineData format
        const filePart = {
            inlineData: {
                data: req.file.buffer.toString("base64"),
                mimeType: req.file.mimetype
            }
        };

        // 1. Define the Strict Tool Schema (EXPANDED)
        const flagSafetyHazardTool = {
            name: "flagSafetyHazard",
            description: "Flags severe safety hazards, logistics, permits, and stunt requirements for a film production.",
            parameters: {
                type: "OBJECT",
                properties: {
                    riskLevel: { type: "STRING", description: "LOW, MEDIUM, HIGH, or EXTREME" },
                    hazards: { type: "ARRAY", items: { type: "STRING" }, description: "Specific identified hazards" },
                    budgetImpact: { type: "STRING", description: "Estimated cost impact category" },
                    requiresStuntCoordinator: { type: "BOOLEAN", description: "True if stunts are involved" },
                    specialPermits: { type: "ARRAY", items: { type: "STRING" }, description: "Required local permits" },
                    insuranceTier: { type: "STRING", description: "Classify as Standard, Specialized, or High-Risk" },
                    vfxAlternative: { type: "STRING", description: "Suggest a safer, CGI-based alternative." }
                },
                required: ["riskLevel", "hazards", "budgetImpact", "requiresStuntCoordinator", "specialPermits", "insuranceTier", "vfxAlternative"]
            }
        };

        // 2. Execute Gemini with MULTIMODAL input and FORCED tool choice
        console.log("Risk Agent: Forcing function call execution based on visual cue...");
        const response = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            // Pass BOTH the image (filePart) and the text description
            contents: [filePart, { text: `Analyze this visual scene cue for production risks: ${sceneDescription}` }],
            config: {
                tools: [{ functionDeclarations: [flagSafetyHazardTool] }],
                toolConfig: {
                    functionCallingConfig: {
                        mode: "ANY", // <-- The magic word for Forced Function Calling
                        allowedFunctionNames: ["flagSafetyHazard"]
                    }
                }
            }
        });

        // 3. Extract the guaranteed structured data
        const functionCall = response.functionCalls?.[0];
        
        if (!functionCall) {
            throw new Error("Model failed to call the required safety function based on the visual cue.");
        }

        console.log("Forced Function Call Output:", functionCall.args);
        res.json({ success: true, riskReport: functionCall.args });

    } catch (error) {
        console.error("Risk Agent Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// FEATURE 14: DIALOGUE SENTIMENT ANALYSIS
// ==========================================
app.post('/api/sentiment-analysis', upload.single('audioTake'), async (req, res) => {
    let gcsAudio = null;
    try {
        console.log("Incoming Dialogue Sentiment Analysis request...");
        const { intendedScript } = req.body;
        const audioFile = req.file;

        if (!intendedScript || !audioFile) {
            return res.status(400).json({ success: false, error: "Audio file and intended script are required." });
        }

        // 1. Upload the audio take to Google Cloud Storage
        const uploadResponse = await uploadToGCS(audioFile.path, audioFile.originalname, audioFile.mimetype);
        gcsAudio = uploadResponse.destFileName;

        // 2. Multimodal Sentiment Prompt (EXPANDED)
        const prompt = `You are a Hollywood Dialogue Coach, Audio Engineer, and Sentiment Analyzer.
        Listen to this audio take and compare the vocal tone, emotion, pacing, and technical quality against this intended script: "${intendedScript}".
        
        Return STRICTLY a JSON object with this exact structure:
        {
            "deliveryMatchesScript": boolean,
            "overallScore": "Number between 1-100 representing performance quality",
            "detectedTone": "String describing the actor's actual emotional tone",
            "pacingAndCadence": "String analyzing the speed, pauses, and rhythm of the delivery",
            "emotionalResonance": "String analyzing how well the emotion fits the intended scene context",
            "technicalAudioQuality": "String noting any background noise, clipping, or clarity issues",
            "directorNotes": "2-3 sentences of overall feedback",
            "suggestedTakeTwo": "Specific, actionable directions for the actor for the next take"
        }`;

        console.log("Analyzing audio tone against script text...");
        const analysisRes = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: [
                prompt, 
                { fileData: { fileUri: uploadResponse.gcsUri, mimeType: audioFile.mimetype } }
            ],
            config: { responseMimeType: "application/json" }
        });

        const sentimentReport = JSON.parse(analysisRes.text);
        console.log("Sentiment Analysis complete:", sentimentReport);

        // 3. Cleanup
        if (fs.existsSync(audioFile.path)) fs.unlinkSync(audioFile.path);
        await deleteFromGCS(gcsAudio);

        res.json({ success: true, report: sentimentReport });

    } catch (error) {
        console.error("Sentiment Analysis Error:", error);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        if (gcsAudio) await deleteFromGCS(gcsAudio);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// FEATURE 15: MCP DATABASE TOOLBOX (PRODUCTION PLANNING)
// ==========================================
// Vault Access Control: the agent may only read these production collections.
// (Prevents a crafted prompt from steering the tool at unrelated collections,
// e.g. the `users` auth collection.)
const PRODUCTION_PLANNING_COLLECTION_ALLOWLIST = ['scenes', 'cast', 'equipment', 'assets'];

app.post('/api/production-planning', upload.none(), async (req, res) => {
    try {
        console.log("Incoming MCP Production Planning request...");
        const { prompt, collectionHint, history } = req.body;

        if (!prompt) return res.status(400).json({ success: false, error: "Prompt required." });

        // Optional prior turns from the client, so a follow-up question keeps context
        // without the server having to hold any session state in memory.
        let parsedHistory = [];
        if (history) {
            try {
                const raw = JSON.parse(history);
                if (Array.isArray(raw)) {
                    parsedHistory = raw
                        .filter(turn => turn && (turn.role === 'user' || turn.role === 'model') && typeof turn.text === 'string')
                        .slice(-10) // keep the payload bounded
                        .map(turn => ({ role: turn.role, parts: [{ text: turn.text }] }));
                }
            } catch (parseErr) {
                console.warn("Ignoring malformed history payload:", parseErr.message);
            }
        }

        // 1. Define the MCP-Compliant Database Tool
        const mcpVaultTool = {
            name: "mcp_query_vault",
            description: "Model Context Protocol (MCP) tool to query the Firestore production database for actor schedules, scene status, equipment, and asset availability.",
            parameters: {
                type: "OBJECT",
                properties: {
                    collection: { 
                        type: "STRING", 
                        description: "The Firestore collection to query. Must be one of: 'scenes', 'cast', 'equipment', 'assets'." 
                    },
                    documentId: { 
                        type: "STRING", 
                        description: "Specific document ID to fetch (optional)" 
                    },
                    searchIntent: { 
                        type: "STRING", 
                        description: "What information the agent is looking for" 
                    }
                },
                required: ["collection", "searchIntent"]
            }
        };

        console.log("Planning Agent: Initializing with MCP Database Toolbox...");

        // 2. Initial execution: Let Gemini inspect the prompt and trigger the MCP tool
        const chatSession = ai.chats.create({
            model: 'gemini-3.6-flash',
            history: parsedHistory,
            config: {
                systemInstruction: "You are an autonomous Production Planning Agent. Use the mcp_query_vault tool to inspect live Firestore database records across scenes, cast, equipment, and assets before formulating your production schedule and logistics plan. You may call the tool more than once (e.g. cast, then equipment) if the question needs it before giving your final answer.",
                tools: [{ functionDeclarations: [mcpVaultTool] }]
            }
        });

        // If the user clicked a quick-filter chip, nudge the agent toward that collection
        // without forcing it — it can still look elsewhere if the question needs it.
        const effectivePrompt = collectionHint
            ? `${prompt}\n\n(Hint: start by checking the "${collectionHint}" collection.)`
            : prompt;

        let result = await chatSession.sendMessage({ message: effectivePrompt });
        let finalAnswer = result.text;
        const mcpSteps = [];

        // 3. Real MCP Protocol Execution Loop — the agent may need several queries
        // (e.g. cast availability AND equipment status) before it can answer, so we
        // keep feeding tool results back until it stops asking, capped for safety.
        const MAX_TOOL_ROUNDS = 5;
        let round = 0;

        while (result.functionCalls && result.functionCalls.length > 0 && round < MAX_TOOL_ROUNDS) {
            round++;
            const mcpCall = result.functionCalls[0];
            console.log(`MCP Tool Triggered by Agent (round ${round}):`, mcpCall.name, mcpCall.args);

            // Normalize + validate collection name against the allowlist
            const rawCol = (mcpCall.args.collection || 'scenes').toLowerCase().trim();
            let mcpDatabaseResponse;

            if (!PRODUCTION_PLANNING_COLLECTION_ALLOWLIST.includes(rawCol)) {
                console.warn(`Blocked MCP query — "${rawCol}" is outside the production planning allowlist.`);
                mcpDatabaseResponse = {
                    collectionQueried: rawCol,
                    recordsFound: 0,
                    data: [],
                    mcpStatus: `403 BLOCKED — "${rawCol}" is not a production planning collection. Allowed: ${PRODUCTION_PLANNING_COLLECTION_ALLOWLIST.join(', ')}.`
                };
            } else {
                console.log(`Executing REAL MCP query against Firestore collection: "${rawCol}"`);
                let records = [];
                try {
                    if (mcpCall.args.documentId) {
                        const docSnap = await db.collection(rawCol).doc(mcpCall.args.documentId).get();
                        if (docSnap.exists) {
                            records.push({ id: docSnap.id, ...docSnap.data() });
                        }
                    } else {
                        const snapshot = await db.collection(rawCol).limit(10).get();
                        snapshot.forEach(doc => {
                            records.push({ id: doc.id, ...doc.data() });
                        });
                    }
                } catch (dbErr) {
                    console.error(`Firestore query failed on collection "${rawCol}":`, dbErr.message);
                    throw new Error(`MCP Database Failure: Could not read from "${rawCol}". ${dbErr.message}`);
                }

                mcpDatabaseResponse = {
                    collectionQueried: rawCol,
                    recordsFound: records.length,
                    data: records.length > 0 ? records : [{ notice: `Collection "${rawCol}" queried successfully. 0 documents currently stored.` }],
                    mcpStatus: "200 OK - LIVE FIRESTORE ACCESSED"
                };
            }

            mcpSteps.push({
                tool: mcpCall.name,
                args: mcpCall.args,
                dbResponse: mcpDatabaseResponse
            });

            // 4. Return the live database context back to Gemini and see if it needs
            // another query or is ready to synthesize the plan.
            console.log("Returning live MCP Firestore data back to Gemini...");
            result = await chatSession.sendMessage({
                message: [{
                    functionResponse: {
                        name: mcpCall.name,
                        response: mcpDatabaseResponse
                    }
                }]
            });
            finalAnswer = result.text;
        }

        res.json({ 
            success: true, 
            plan: finalAnswer, 
            // Kept for backwards compatibility with older clients that read a single mcpLog
            mcpLog: mcpSteps.length > 0 ? mcpSteps[0] : null,
            // Full multi-step audit trail
            mcpSteps
        });

    } catch (error) {
        console.error("MCP Planning Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// FEATURE 16: GOOGLE MAPS LOCATION SCOUT AGENT
// ==========================================
app.post('/api/maps-scout', upload.none(), async (req, res) => {
    try {
        console.log("Incoming Maps Agent request...");
        const { prompt } = req.body;
        if (!prompt) return res.status(400).json({ success: false, error: "Prompt required." });

        // HELPER: Automatic retry logic to bypass Google Cloud 429 Quota Exhaustion
        const fetchWithRetry = async (params, retries = 3) => {
            for (let i = 0; i < retries; i++) {
                try {
                    return await ai.models.generateContent(params);
                } catch (err) {
                    if (err.status === 429 && i < retries - 1) {
                        console.log(`⏳ [Quota Hit] Vertex AI is cooling down. Retrying in 4 seconds...`);
                        await new Promise(r => setTimeout(r, 4000));
                    } else {
                        throw err;
                    }
                }
            }
        };

        // Step 1: Agent inspects prompt and executes Google Maps tool calls
        // In server.js inside /api/maps-scout:
        const scoutCallRes = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: prompt,
            config: {
                systemInstruction: "You are a professional Hollywood Location Scout Agent. Analyze the scene and use the searchLocations tool to search Google Maps for real-world filming locations that match the setting, atmosphere, and country/city implied by the script.",
                tools: [{ functionDeclarations: [mapsScoutTool] }],
                // FORCE THE TOOL CALL
                toolConfig: {
                    functionCallingConfig: {
                        mode: "ANY",
                        allowedFunctionNames: ["searchLocations"]
                    }
                }
            }
        });

        let mapData = [];
        let topLocationStr = "";
        let scoutSummary = "";

        const functionCalls = scoutCallRes.functionCalls || [];
        if (functionCalls.length > 0) {
            console.log(`Agent triggered ${functionCalls.length} parallel Google Maps tool searches.`);
            
            for (const call of functionCalls) {
                const loc = call.args.location;
                const q = call.args.query;
                if (!loc || !q) throw new Error("Agent failed to provide valid location or query arguments for Maps search.");
                
                console.log(`Searching Maps: "${q}" in "${loc}"`);
                
                let foundItems = [];
                try {
                    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
                    if (!apiKey || apiKey === 'missing_key') throw new Error("GOOGLE_MAPS_API_KEY is missing or invalid.");

                    const mapsRes = await mapsClient.textSearch({
                        params: { query: `${q} in ${loc}`, key: apiKey }
                    });
                    
                    foundItems = mapsRes.data.results.slice(0, 3).map(r => ({
                        name: r.name,
                        formatted_address: r.formatted_address,
                        rating: r.rating,
                        place_id: r.place_id,
                        maps_url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.name)}&query_place_id=${r.place_id}`
                    }));
                } catch (err) {
                    console.error(`Google Maps Infrastructure Error:`, err.message);
                    throw new Error(`Google Maps API failed to execute tool search: ${err.message}`);
                }
                
                mapData.push(...foundItems);
                scoutSummary += `\n- Searched [${q} in ${loc}]: Found ${foundItems.map(f => f.name + ' at ' + f.formatted_address).join(', ')}`;
            }

            if (mapData.length > 0) topLocationStr = mapData[0].formatted_address || mapData[0].name;
        } else {
            scoutSummary = "Analyzed script setting directly from production brief.";
        }

        // Step 2: Agent synthesizes the gathered Maps data into a full Hollywood report
        const synthesisPrompt = `The director submitted this scene outline:\n"""\n${prompt}\n"""\n\nGoogle Maps autonomous scout results:\n${scoutSummary}\n\nGenerate a comprehensive, structured **Location Scout Report** with:\n1. Target Region & Setting: State the country, city, and architectural style needed.\n2. Recommended Filming Locations: Review the scouted Google Maps locations above and explain why each matches the mood and scale of the scene.\n3. Production Logistics & Staging: Give practical tips on lighting, weather setup, and practical filming requirements.`;

        const reportRes = await fetchWithRetry({
            model: 'gemini-3.6-flash',
            contents: synthesisPrompt,
            config: { systemInstruction: "You are an elite Hollywood Location Scout. Output a sharp, professional, and practical report for the production crew." }
        });

        res.json({
            success: true,
            answer: reportRes.text,
            rawMapData: mapData.length > 0 ? mapData : null,
            topLocation: topLocationStr
        });
    } catch (error) {
        console.error("Maps Agent Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// FEATURE 17: GEMINI LIVE API (WEBSOCKET BRIDGE)
// ==========================================

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`CineMatch Agentic Backend live at http://localhost:${PORT}`);
});
server.timeout = 300000;

const wss = new WebSocketServer({ server });

wss.on('connection', async (clientWs) => {
    console.log("🎙️ Frontend UI connected to WebSocket bridge.");
    let geminiWs = null;

    try {
        const apiKey = process.env.GEMINI_API_KEY;
        // MUST use v1beta for live bidirectional streaming
        const serviceUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
        
        geminiWs = new WebSocket(serviceUrl);

        geminiWs.on('open', () => {
            console.log("✅ Backend securely connected to Gemini Live API.");
            
            const setupMessage = {
                setup: {
                    model: "models/gemini-3.1-flash-live-preview", // Official live-supported model string
                    generationConfig: { 
                        responseModalities: ["AUDIO"] 
                    }
                }
            };
            geminiWs.send(JSON.stringify(setupMessage));
        });

        geminiWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                
                if (msg.setupComplete) {
                    console.log("✅ Gemini Live Session Setup Complete! Ready for audio.");
                    clientWs.send(JSON.stringify({ text: "Connected to Gemini Live endpoint. Ready for bidirectional audio stream." }));
                }

                if (msg.serverContent && msg.serverContent.modelTurn) {
                    const parts = msg.serverContent.modelTurn.parts;
                    parts.forEach(p => { 
                        if (p.text) {
                            clientWs.send(JSON.stringify({ text: p.text }));
                        }
                        if (p.inlineData && p.inlineData.data) {
                            clientWs.send(JSON.stringify({ audio: p.inlineData.data }));
                        }
                    });
                }
                
                if (msg.error) {
                    console.error("Gemini API Error:", msg.error);
                    clientWs.send(JSON.stringify({ text: `⚠️ Gemini Error: ${msg.error.message}` }));
                }
            } catch(e) {
                console.error("Error parsing Gemini message:", e.message);
            }
        });

        geminiWs.on('close', (code, reason) => {
            console.log(`🛑 Gemini API closed connection. Code: ${code}, Reason: ${reason.toString()}`);
            clientWs.send(JSON.stringify({ text: "⚠️ Gemini Live Session Ended by Server." }));
        });

        // Route live microphone bytes from Browser Frontend -> Gemini
        let audioPacketCount = 0;

        clientWs.on('message', (data, isBinary) => {
            if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
                if (isBinary) {
                    const base64Audio = Buffer.from(data).toString('base64');
                    
                    // THE REAL FIX: Use the official v1beta realtimeInput schema
                    // This lets Gemini's Voice Activity Detector (VAD) natively detect when you stop talking
                    const audioPayload = {
                        realtimeInput: {
                            audio: {
                                data: base64Audio,
                                mimeType: "audio/pcm;rate=16000"
                            }
                        }
                    };
                    
                    geminiWs.send(JSON.stringify(audioPayload));

                    audioPacketCount++;
                    if (audioPacketCount % 50 === 0) {
                        console.log(`🎤 Streamed ${audioPacketCount} live audio packets to Gemini...`);
                    }
                }
            }
        });

        clientWs.on('close', () => {
            console.log("🛑 Frontend closed connection. Terminating Gemini session.");
            if (geminiWs) geminiWs.close();
        });

    } catch (err) {
        console.error("Live API setup failed:", err.message);
        clientWs.send(JSON.stringify({ text: `⚠️ Backend initialization failed: ${err.message}` }));
        clientWs.close();
    }
});
import { Firestore } from '@google-cloud/firestore';

// This automatically picks up your active Google Cloud credentials 
// from your environment, just like your Storage and Vertex AI setup.
const firestore = new Firestore({
    projectId: process.env.GOOGLE_CLOUD_PROJECT_ID || 'project-051c2796-a8db-43d9-99c'
});

export const db = firestore;
export const Users = db.collection('users');
export const AuditHistory = db.collection('auditHistory');
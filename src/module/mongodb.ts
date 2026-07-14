import { MongoClient } from 'mongodb';

const DEFAULT_DB_NAME = 'zalo_sleiz_bot';

let clientPromise: Promise<MongoClient> | null = null;
let hasLoggedConnect = false;

function getMongoUri(): string {
    return process.env.MONGODB_URI?.trim() || '';
}

export function getMongoDbName(): string {
    return process.env.MONGODB_DB_NAME?.trim() || DEFAULT_DB_NAME;
}

export function isMongoConfigured(): boolean {
    return getMongoUri().length > 0;
}

async function getMongoClient(): Promise<MongoClient | null> {
    const uri = getMongoUri();
    if (!uri) return null;
    if (!clientPromise) {
        const client = new MongoClient(uri, {
            appName: 'Zalo-NguyenDinhDuong-Bot',
        });
        clientPromise = client.connect();
    }
    try {
        const client = await clientPromise;
        if (!hasLoggedConnect) {
            hasLoggedConnect = true;
            console.log(`[MongoDB] ✓ Connected to database "${getMongoDbName()}"`);
        }
        return client;
    } catch (error) {
        clientPromise = null;
        throw error;
    }
}

async function withCollection<T>(
    collectionName: string,
    handler: (collection: any) => Promise<T>,
): Promise<T | null> {
    const client = await getMongoClient();
    if (!client) return null;
    const db = client.db(getMongoDbName());
    const collection = db.collection(collectionName);
    return handler(collection);
}

function logMongoError(action: string, collectionName: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[MongoDB] ${action} failed for ${collectionName}: ${message}`);
}

export function mongoUpsertOne(
    collectionName: string,
    filter: Record<string, any>,
    document: Record<string, any>,
): void {
    void withCollection(collectionName, async (collection) => {
        const now = new Date();
        await collection.replaceOne(
            filter,
            { ...document, updatedAt: now },
            { upsert: true },
        );
    }).catch((error) => logMongoError('upsert', collectionName, error));
}

export function mongoInsertOne(
    collectionName: string,
    document: Record<string, any>,
): void {
    void withCollection(collectionName, async (collection) => {
        await collection.insertOne({ ...document, syncedAt: new Date() });
    }).catch((error) => logMongoError('insert', collectionName, error));
}

export function mongoUpsertState(
    stateKey: string,
    data: Record<string, any> | any[],
): void {
    mongoUpsertOne(
        'app_state',
        { _id: stateKey },
        {
            _id: stateKey,
            data,
        },
    );
}

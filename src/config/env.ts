import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
    PORT: z.coerce.number().default(4000),
    SUPABASE_URL: z.string().url(),
    SUPABASE_ANON_KEY: z.string().min(10),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(10),
    CORS_ORIGIN: z.string().default('http://localhost:5173'),
    AI_SERVICE_URL: z.string().url().default('http://localhost:8000'),
    AI_SERVICE_KEY: z.string().min(8),
    ALLOW_PUBLIC_EMAIL_DOMAINS: z
        .enum(['true', 'false'])
        .default('false')
        .transform((v) => v === 'true'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
    console.error('Invalid environment variables:', parsed.error.issues);
    process.exit(1);
}

export const env = parsed.data;
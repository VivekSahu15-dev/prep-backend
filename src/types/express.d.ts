import type { Role } from '../middleware/auth';

declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string; email: string; role: Role; collegeId: string | null };
    }
  }
}

export {};
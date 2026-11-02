import { env } from '../config/env';

export type ParsedSkill = {
  name: string;
  category: string;
  source: 'skills_section' | 'body' | 'manual';
};

export type ParseResult =
  | { ok: true; skills: ParsedSkill[]; githubUrl: string | null; linkedinUrl: string | null }
  | { ok: false; message: string };


const UNAVAILABLE =
  'Your resume was saved, but the skill scan is unavailable right now. Try again in a few minutes.';

export async function parseResume(pdf: Buffer): Promise<ParseResult> {
  try {
    const form = new FormData();
    form.append('file', new Blob([pdf as unknown as ArrayBuffer], { type: 'application/pdf' }), 'resume.pdf');

    const res = await fetch(`${env.AI_SERVICE_URL}/parse-resume`, {
      method: 'POST',
      headers: { 'X-Service-Key': env.AI_SERVICE_KEY },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    const json: any = await res.json().catch(() => ({}));

    if (res.ok) {
      return {
        ok: true,
        skills: json.skills as ParsedSkill[],
        githubUrl: json.github_url ?? null,
        linkedinUrl: json.linkedin_url ?? null,
      };
    }
    // 400/413/422 mean the file itself is the problem (scanned, password-protected, too big).
    // The AI service writes those messages for the student, so pass them through.
    if ([400, 413, 422].includes(res.status) && typeof json.detail === 'string') {
      return { ok: false, message: json.detail };
    }
    console.error('AI service error', res.status, json);
    return { ok: false, message: UNAVAILABLE };
  } catch (err) {
    console.error('AI service unreachable', err);
    return { ok: false, message: UNAVAILABLE };
  }
}

// Suggests skill names found in a job description. Returns null when the service is unavailable.
export async function extractSkillsFromText(text: string): Promise<string[] | null> {
  try {
    const res = await fetch(`${env.AI_SERVICE_URL}/extract-skills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': env.AI_SERVICE_KEY },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error('AI service error', res.status);
      return null;
    }
    const json: any = await res.json();
    return json.skills as string[];
  } catch (err) {
    console.error('AI service unreachable', err);
    return null;
  }
}



// ---------- Questions: import from a PDF, or generate with AI ----------

export type QuestionCategory = 'technical' | 'aptitude' | 'coding';

export type DraftQuestion = {
  question: string;
  options: string[];
  correctIndex: number;
  category: QuestionCategory;
  codeSnippet: string | null;
};

const toDraft = (q: any): DraftQuestion => ({
  question: q.question,
  options: q.options,
  correctIndex: q.correct_index,
  category: q.category ?? 'technical',
  codeSnippet: q.code_snippet ?? null,
});

const QUESTIONS_UNAVAILABLE = 'The question tools are unavailable right now. Add the questions by hand.';

export async function parseQuestionsPdf(
  pdf: Buffer
): Promise<{ ok: true; questions: DraftQuestion[]; skipped: string[] } | { ok: false; status: number; message: string }> {
  try {
    const form = new FormData();
    form.append('file', new Blob([pdf as unknown as ArrayBuffer], { type: 'application/pdf' }), 'questions.pdf');
    const res = await fetch(`${env.AI_SERVICE_URL}/parse-questions`, {
      method: 'POST',
      headers: { 'X-Service-Key': env.AI_SERVICE_KEY },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, questions: (json.questions ?? []).map(toDraft), skipped: json.skipped ?? [] };
    if ([400, 413, 422].includes(res.status) && typeof json.detail === 'string') {
      return { ok: false, status: 422, message: json.detail };
    }
    console.error('AI service error', res.status, json);
    return { ok: false, status: 503, message: QUESTIONS_UNAVAILABLE };
  } catch (err) {
    console.error('AI service unreachable', err);
    return { ok: false, status: 503, message: QUESTIONS_UNAVAILABLE };
  }
}

export type GenerateInput = {
  topic: string;
  skills: string[];
  difficulty: 'easy' | 'medium' | 'hard';
  technical: number;
  aptitude: number;
  coding: number;
};

export async function generateQuestions(
  input: GenerateInput
): Promise<{ ok: true; questions: DraftQuestion[]; dropped: number } | { ok: false; status: number; message: string }> {
  try {
    const res = await fetch(`${env.AI_SERVICE_URL}/generate-questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': env.AI_SERVICE_KEY },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(75_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, questions: (json.questions ?? []).map(toDraft), dropped: json.dropped ?? 0 };
    // The AI service writes these messages for the recruiter (quota used up, key missing, and so on).
    if ([422, 429, 502, 503].includes(res.status) && typeof json.detail === 'string') {
      return { ok: false, status: res.status, message: json.detail };
    }
    console.error('AI service error', res.status, json);
    return { ok: false, status: 503, message: QUESTIONS_UNAVAILABLE };
  } catch (err) {
    console.error('AI service unreachable', err);
    return { ok: false, status: 503, message: QUESTIONS_UNAVAILABLE };
  }
}
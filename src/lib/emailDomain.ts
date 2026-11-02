const PUBLIC_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'yahoo.in', 'outlook.com', 'hotmail.com',
  'live.com', 'icloud.com', 'proton.me', 'protonmail.com', 'rediffmail.com', 'aol.com',
]);

export const domainOf = (email: string) => email.split('@').pop()!.toLowerCase();

export const isPublicDomain = (domain: string) => PUBLIC_DOMAINS.has(domain);

export function emailMatchesCollege(email: string, collegeDomain: string) {
  const d = domainOf(email);
  const c = collegeDomain.toLowerCase();
  return d === c || d.endsWith('.' + c);
}
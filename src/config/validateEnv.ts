/**
 * Production must not start with a missing or weak secret: a missing encryption key would encrypt personal
 * data with an empty key, and a short signing secret makes sign-in tokens guessable. This lists what is
 * wrong so the server can refuse to start and say why (the names only, never the values).
 */
const SECRETS: { name: string; minLength: number; what: string }[] = [
  { name: 'JWT_ACCESS_SECRET', minLength: 32, what: 'staff sign-in tokens' },
  { name: 'JWT_REFRESH_SECRET', minLength: 32, what: 'staying signed in' },
  { name: 'ENCRYPTION_KEY', minLength: 32, what: 'encrypting PAN, Aadhaar and bank numbers' },
  { name: 'QR_HMAC_SECRET', minLength: 32, what: 'signing kiosk QR codes' },
];

export function productionConfigProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  if (!env.DATABASE_URL) problems.push('DATABASE_URL is not set (the database address).');
  for (const s of SECRETS) {
    const v = env[s.name] || '';
    if (!v) problems.push(`${s.name} is not set (used for ${s.what}).`);
    else if (v.length < s.minLength)
      problems.push(`${s.name} is shorter than ${s.minLength} characters (used for ${s.what}).`);
  }
  return problems;
}

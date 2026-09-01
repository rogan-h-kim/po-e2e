/** Short random id for steps (scenarios use crypto.randomUUID - see scenarios.ts). */
export const uid = () => Math.random().toString(36).slice(2, 10);

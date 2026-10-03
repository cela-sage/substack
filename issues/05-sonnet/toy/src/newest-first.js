export const newestFirst = (list) => [...list].sort((a, b) => b.date.localeCompare(a.date));

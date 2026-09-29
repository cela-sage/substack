import { issues } from "./issues.js";
import { newestFirst } from "./newest-first.js";
import { formatDate } from "./format-date.js";

export const latest = (count = 3) =>
  newestFirst(issues)
    .slice(0, count)
    .map((issue) => `#${issue.number} · ${formatDate(issue.date)}`);

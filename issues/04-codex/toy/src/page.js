import { issues } from "./issues.js";
import { newestFirst } from "./newest-first.js";
import { offset } from "./offset.js";

export const perPage = 5;

export const pageOf = (page) => {
  const start = offset(page, perPage);
  return newestFirst(issues)
    .slice(start, start + perPage)
    .map((issue) => issue.number);
};

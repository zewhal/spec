declare module "markdown-it";
declare module "markdown-it/lib/token.mjs";

type MarkdownItToken = {
  type: string;
  tag: string;
  content: string;
};

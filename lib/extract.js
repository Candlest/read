// 正文提取与 HTML 清理
import * as cheerio from "cheerio";
import { createRequire } from "node:module";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const PDFJS_DIR = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));

// 按页提取 PDF 文本，每页一个分块，保留页码供引用定位。
export async function extractPdfText(buffer) {
  const task = getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    standardFontDataUrl: path.join(PDFJS_DIR, "standard_fonts") + path.sep,
  });
  const doc = await task.promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items) {
      text += item.str;
      text += item.hasEOL ? "\n" : "";
    }
    pages.push({ page: i, text: text.trim() });
  }
  const info = await doc.getMetadata().catch(() => null);
  await task.destroy();
  return { chunks: pages, numPages: pages.length, title: info?.info?.Title || "" };
}

// 清理导入的 HTML：删除脚本与事件属性，将相对地址改写为绝对地址。
// 页面作为对照原文在 iframe 中显示，服务端返回时另设 CSP 禁止脚本。
export function sanitizeHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  $("script, noscript, iframe, object, embed, form, base, meta[http-equiv]").remove();
  $("*").each((_, el) => {
    for (const name of Object.keys(el.attribs || {})) {
      if (/^on/i.test(name)) $(el).removeAttr(name);
    }
  });

  // arXiv HTML：只保留论文正文，去掉站点导航
  const article = $("article.ltx_document").first();
  if (article.length) {
    $("body").empty().append(article);
  }
  $("header.desktop_header, .ltx_page_header, .ltx_page_footer, #main > nav").remove();

  if (baseUrl) {
    const abs = (v) => {
      if (!v || v.startsWith("#") || v.startsWith("data:")) return v;
      try {
        return new URL(v, baseUrl).href;
      } catch {
        return v;
      }
    };
    $("[src]").each((_, el) => $(el).attr("src", abs($(el).attr("src"))));
    $("link[href], a[href]").each((_, el) => $(el).attr("href", abs($(el).attr("href"))));
    $("[srcset]").each((_, el) => {
      const set = $(el)
        .attr("srcset")
        .split(",")
        .map((part) => {
          const [u, ...rest] = part.trim().split(/\s+/);
          return [abs(u), ...rest].join(" ");
        })
        .join(", ");
      $(el).attr("srcset", set);
    });
  }
  $("a[href]").attr("target", "_blank").attr("rel", "noopener noreferrer");
  $("[href^='javascript:'], [src^='javascript:']").removeAttr("href").removeAttr("src");
  return $.html();
}

export function htmlTitle(html) {
  const $ = cheerio.load(html);
  return ($("h1.ltx_title_document").text() || $("title").text() || $("h1").first().text()).replace(/\s+/g, " ").trim();
}

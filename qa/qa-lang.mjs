// Language of the QA run: Korean by default, English with PPV_LANG=en. tx(ko, en) picks the UI text
// (string or RegExp) a harness matches on; withLang(browser) makes every new context start in that language.
export const QA_LANG = process.env.PPV_LANG === "en" ? "en" : "ko";
export const tx = (ko, en) => (QA_LANG === "en" ? en : ko);

export function withLang(browser) {
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...a) => {
    const ctx = await newContext(...a);
    await ctx.addInitScript((l) => localStorage.setItem("pp-lang", l), QA_LANG);
    return ctx;
  };
  return browser;
}

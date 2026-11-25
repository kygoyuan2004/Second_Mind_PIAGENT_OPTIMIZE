export function isSubagentEligible(promptInput) {
  const prompt = String(promptInput || '').trim();
  if (!prompt) return false;
  if (
    /(?:全面|完整|彻底)(?:审计|核查|检查|复盘)|(?:全库|所有文件|全部文件)(?:比较|对比|核查|检索|审计)|跨(?:多个|至少两个|不同)(?:目录|文档)/u.test(prompt)
  ) return true;
  const directories = new Set(
    [...prompt.matchAll(/(?:^|\s|[`'"“”])([^\s`'"“”/\\]+)[/\\][^\s`'"“”]+/gu)]
      .map((match) => match[1].toLocaleLowerCase('zh-CN')),
  );
  if (directories.size >= 2) return true;
  const enumeratedThemes = prompt.split(/\r?\n/).filter((line) => (
    /^\s*(?:[-*+]\s+|\d+[.)、]\s*|[一二三四五六七八九十]+[、.．)]\s*)\S/u.test(line)
  ));
  return enumeratedThemes.length >= 3;
}

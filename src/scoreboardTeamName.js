const latinOnlyNamePattern = /^[\sA-Za-z0-9 .,&+_-]+$/;
const latinFragmentPattern = /([A-Za-z][A-Za-z0-9&+_-]*)/g;
const visibleNameCharacterPattern = /[\p{L}\p{N}]/gu;

export function getScoreboardTeamNamePresentation(name) {
  const text = String(name ?? "");
  const visibleCharacterCount = text.match(visibleNameCharacterPattern)?.length ?? 0;
  const isLatinName = latinOnlyNamePattern.test(text);
  const isShortDisplayName = visibleCharacterCount > 0 && visibleCharacterCount <= 8;
  const isCompactName = Array.from(text.trim()).length <= 20;
  const fragments = text.split(latinFragmentPattern).filter(Boolean);
  const className = [
    isLatinName ? "is-latin-name" : "",
    isShortDisplayName ? "is-short-display-name" : "",
    isCompactName ? "is-compact-name" : "",
  ].filter(Boolean).join(" ") || undefined;

  return { text, fragments, className };
}

export function isScoreboardLatinFragment(fragment) {
  return /[A-Za-z]/.test(fragment);
}

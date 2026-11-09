/** Keep the Safari-specific storage route scoped to an installed iPhone PWA. */
export function shouldUseIPhonePwaAudioUpload(input: {
  userAgent: string;
  standalone: boolean;
}): boolean {
  const isIPhone = /iPhone|iPod/i.test(input.userAgent);
  const isSafari = /Safari/i.test(input.userAgent) && !/(CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo)/i.test(input.userAgent);
  return isIPhone && isSafari && input.standalone;
}

export function isSafariOrIOS(userAgent?: string): boolean {
  if (typeof window === "undefined" && !userAgent) return false;
  const ua = userAgent || (typeof window !== "undefined" ? window.navigator.userAgent : "");
  const isIOS = /iPad|iPhone|iPod/i.test(ua);
  const isSafari = /Safari/i.test(ua) && !/(Chrome|CriOS|Firefox|FxiOS|Edg|OPR)/i.test(ua);
  return isIOS || isSafari;
}

export function isIPhoneSafariPwa(): boolean {
  if (typeof window === "undefined") return false;
  const standalone =
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia?.("(display-mode: standalone)").matches === true;
  return shouldUseIPhonePwaAudioUpload({
    userAgent: window.navigator.userAgent,
    standalone,
  });
}

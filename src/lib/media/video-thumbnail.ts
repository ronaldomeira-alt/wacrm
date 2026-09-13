"use client";

// In-memory module-level cache for video thumbnails (key -> data URL or blob URL)
const localThumbnailRegistry = new Map<string, string>();

/**
 * Registers an in-memory thumbnail (JPEG data URL) for a video key, temp ID, or blob URL.
 */
export function registerLocalVideoThumbnail(key: string, thumbnailDataUrl: string): void {
  if (!key || !thumbnailDataUrl) return;
  localThumbnailRegistry.set(key, thumbnailDataUrl);
}

/**
 * Retrieves a registered local thumbnail if available.
 */
export function getLocalVideoThumbnail(key: string | undefined | null): string | undefined {
  if (!key) return undefined;
  return localThumbnailRegistry.get(key);
}

/**
 * Extracts a thumbnail image from a video File, Blob, or URL using a hidden HTML5 video element and canvas.
 * Works natively on iOS Safari (including QuickTime .mov files) and all modern browsers.
 */
export async function extractVideoThumbnailViaElement(
  fileOrUrl: File | Blob | string,
): Promise<string> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return "";
  }

  return new Promise<string>((resolve) => {
    let urlToRevoke: string | null = null;
    let url: string;

    if (typeof fileOrUrl === "string") {
      url = fileOrUrl;
    } else {
      url = URL.createObjectURL(fileOrUrl);
      urlToRevoke = url;
    }

    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.style.position = "fixed";
    video.style.top = "-9999px";
    video.style.left = "-9999px";
    video.style.width = "1px";
    video.style.height = "1px";
    video.style.opacity = "0";
    video.style.pointerEvents = "none";
    try {
      document.body.appendChild(video);
    } catch {
      // document.body might not be ready in rare non-browser environments
    }

    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("loadeddata", onLoadedData);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      video.src = "";
      if (video.parentNode) {
        try {
          video.parentNode.removeChild(video);
        } catch {
          // ignore
        }
      }
      if (urlToRevoke) {
        try {
          URL.revokeObjectURL(urlToRevoke);
        } catch {
          // ignore
        }
      }
    };

    const done = (result: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const capture = () => {
      try {
        const rawW = video.videoWidth;
        const rawH = video.videoHeight;
        if (rawW > 0 && rawH > 0) {
          const w = Math.min(rawW, 480);
          const scale = w / rawW;
          const h = Math.round(rawH * scale);
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(video, 0, 0, w, h);
            const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
            if (dataUrl && dataUrl.length > 50) {
              done(dataUrl);
              return;
            }
          }
        }
      } catch {
        // tainted canvas or draw failure
      }
    };

    let seekTriggered = false;
    const triggerSeek = () => {
      if (seekTriggered) return;
      seekTriggered = true;
      try {
        if (video.duration && Number.isFinite(video.duration) && video.duration > 0) {
          video.currentTime = Math.min(0.05, video.duration / 2);
        } else {
          video.currentTime = 0.001;
        }
      } catch {
        capture();
      }
    };

    const onLoadedMetadata = () => {
      triggerSeek();
    };

    const onLoadedData = () => {
      if (video.readyState >= 2) {
        capture();
      } else {
        triggerSeek();
      }
    };

    const onCanPlay = () => {
      if (video.readyState >= 2) {
        capture();
      }
    };

    const onSeeked = () => {
      capture();
    };

    const onError = () => {
      done("");
    };

    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("loadeddata", onLoadedData);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);

    // Timeout fallback after 2.5s
    timeoutTimer = setTimeout(() => {
      if (!settled) {
        capture();
        done("");
      }
    }, 2500);

    video.src = url;
    try {
      video.load();
    } catch {
      // ignore
    }
  });
}

/**
 * Extracts a thumbnail image using mediabunny WebCodecs CanvasSink.
 * Used as a secondary fallback for formats where native <video> might need decoding assist.
 */
export async function extractVideoThumbnailViaMediabunny(file: File | Blob): Promise<string> {
  try {
    const { Input, ALL_FORMATS, BlobSource, CanvasSink } = await import("mediabunny");
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    const videoTrack = await input.getPrimaryVideoTrack();
    if (videoTrack) {
      const sink = new CanvasSink(videoTrack);
      const wrapped = await sink.getCanvas(0.05);
      if (wrapped?.canvas) {
        const canvas = wrapped.canvas as HTMLCanvasElement;
        return canvas.toDataURL("image/jpeg", 0.82);
      }
    }
  } catch {
    // fallback
  }
  return "";
}

// Module-level sequential queue for thumbnail generation to protect hardware decoders on mobile
let thumbnailQueue: Promise<unknown> = Promise.resolve();

/**
 * Primary API: Extracts a thumbnail JPEG data URL from a video File, Blob, or URL.
 * Automatically checks local thumbnail registry first, then runs fast element extraction,
 * and falls back to WebCodecs if needed.
 * Serialized across multiple files to avoid exhausting iOS WebKit video decoders.
 */
export function extractVideoThumbnail(
  fileOrUrl: File | Blob | string,
  cacheKey?: string,
): Promise<string> {
  if (cacheKey) {
    const cached = getLocalVideoThumbnail(cacheKey);
    if (cached) return Promise.resolve(cached);
  }
  if (typeof fileOrUrl === "string") {
    const cached = getLocalVideoThumbnail(fileOrUrl);
    if (cached) return Promise.resolve(cached);
    return Promise.resolve("");
  }

  // Serial queue ensures at most ONE <video> decoder is active at any given moment
  const nextTask = thumbnailQueue.then(async () => {
    // 1. Try native video element
    const thumb = await extractVideoThumbnailViaElement(fileOrUrl);
    if (thumb) {
      if (cacheKey) registerLocalVideoThumbnail(cacheKey, thumb);
      if (typeof fileOrUrl === "string") registerLocalVideoThumbnail(fileOrUrl, thumb);
      return thumb;
    }

    // 2. Fallback to mediabunny if input is a File or Blob
    if (typeof fileOrUrl !== "string") {
      const mbThumb = await extractVideoThumbnailViaMediabunny(fileOrUrl);
      if (mbThumb) {
        if (cacheKey) registerLocalVideoThumbnail(cacheKey, mbThumb);
        return mbThumb;
      }
    }

    return "";
  });

  thumbnailQueue = nextTask.catch(() => {});
  return nextTask;
}

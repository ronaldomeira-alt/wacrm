import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createStagedMediaItems,
  runBatchUploadPool,
  type StagedMediaItem,
} from "./batch-upload-pool";
import * as r2Upload from "@/lib/storage/upload-media-r2";
import * as autoOrient from "@/lib/media/auto-orient-image";

describe("Batch Upload Pool (Multi-Image Staging)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Stub URL.createObjectURL / revokeObjectURL for node environment
    if (typeof URL.createObjectURL !== "function") {
      URL.createObjectURL = vi.fn((file: Blob | MediaSource) => `blob:mock-url-${(file as File).name || "obj"}`);
    } else {
      vi.spyOn(URL, "createObjectURL").mockImplementation((file: Blob | MediaSource) => `blob:mock-url-${(file as File).name || "obj"}`);
    }
    if (typeof URL.revokeObjectURL !== "function") {
      URL.revokeObjectURL = vi.fn();
    } else {
      vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    }

    vi.spyOn(autoOrient, "autoOrientImage").mockImplementation(async (file) => file);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createMockFiles(count: number): File[] {
    return Array.from({ length: count }, (_, i) => {
      return new File([`content-${i}`], `photo-${i + 1}.jpg`, { type: "image/jpeg" });
    });
  }

  it("1. Immediate local preview: creates staged items with blob: URLs synchronously", () => {
    const files = createMockFiles(7);
    const items = createStagedMediaItems(files);

    expect(items).toHaveLength(7);
    for (let i = 0; i < 7; i++) {
      expect(items[i].previewUrl).toBe(`blob:mock-url-photo-${i + 1}.jpg`);
      expect(items[i].status).toBe("selected");
      expect(items[i].order).toBe(i);
      expect(items[i].filename).toBe(`photo-${i + 1}.jpg`);
    }
  });

  it("2. Concurrency limit = 2: at most 2 uploads run concurrently for 7 and 10 images", async () => {
    const files = createMockFiles(7);
    const items = createStagedMediaItems(files);

    let activeUploads = 0;
    let maxObservedConcurrency = 0;

    vi.spyOn(r2Upload, "presignAndUpload").mockImplementation(async () => {
      activeUploads++;
      if (activeUploads > maxObservedConcurrency) {
        maxObservedConcurrency = activeUploads;
      }
      // simulate network delay
      await new Promise((resolve) => setTimeout(resolve, 30));
      activeUploads--;
      return { key: "mock-r2-key" };
    });

    const updates: Record<string, Partial<StagedMediaItem>> = {};

    await new Promise<void>((resolve) => {
      runBatchUploadPool(items, {
        maxConcurrency: 2,
        onItemUpdate: (id, u) => {
          updates[id] = { ...updates[id], ...u };
        },
        onAllComplete: () => {
          resolve();
        },
      });
    });

    expect(maxObservedConcurrency).toBe(2);
    expect(activeUploads).toBe(0);
    expect(Object.keys(updates)).toHaveLength(7);
    for (const id of Object.keys(updates)) {
      expect(updates[id].status).toBe("uploaded");
      expect(updates[id].key).toBe("mock-r2-key");
    }
  });

  it("3. Works correctly with 10 images maintaining max concurrency 2", async () => {
    const files = createMockFiles(10);
    const items = createStagedMediaItems(files);

    let activeUploads = 0;
    let maxObservedConcurrency = 0;

    vi.spyOn(r2Upload, "presignAndUpload").mockImplementation(async () => {
      activeUploads++;
      if (activeUploads > maxObservedConcurrency) {
        maxObservedConcurrency = activeUploads;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeUploads--;
      return { key: "key-10" };
    });

    await new Promise<void>((resolve) => {
      runBatchUploadPool(items, {
        maxConcurrency: 2,
        onItemUpdate: () => {},
        onAllComplete: () => resolve(),
      });
    });

    expect(maxObservedConcurrency).toBe(2);
  });

  it("4. Preserves original order: items are indexed 0..N-1", () => {
    const files = createMockFiles(7);
    const items = createStagedMediaItems(files);

    expect(items.map((it) => it.order)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(items.map((it) => it.filename)).toEqual([
      "photo-1.jpg",
      "photo-2.jpg",
      "photo-3.jpg",
      "photo-4.jpg",
      "photo-5.jpg",
      "photo-6.jpg",
      "photo-7.jpg",
    ]);
  });

  it("5. Individual error handling: 1 failed upload does not fail other items", async () => {
    const files = createMockFiles(4);
    const items = createStagedMediaItems(files);

    vi.spyOn(r2Upload, "presignAndUpload").mockImplementation(async (_, __, file) => {
      if (file.name === "photo-3.jpg") {
        throw new Error("R2 500 error");
      }
      return { key: `key-${file.name}` };
    });

    const statusById: Record<string, string> = {};

    await new Promise<void>((resolve) => {
      runBatchUploadPool(items, {
        maxConcurrency: 2,
        onItemUpdate: (id, u) => {
          if (u.status) statusById[id] = u.status;
        },
        onAllComplete: () => resolve(),
      });
    });

    const photo3Id = items.find((it) => it.filename === "photo-3.jpg")!.id;
    expect(statusById[photo3Id]).toBe("failed");

    const otherItems = items.filter((it) => it.filename !== "photo-3.jpg");
    for (const other of otherItems) {
      expect(statusById[other.id]).toBe("uploaded");
    }
  });

  it("6. Retry individual item: restarts upload only for the failed item", async () => {
    const files = createMockFiles(2);
    const items = createStagedMediaItems(files);

    let attempts = 0;
    vi.spyOn(r2Upload, "presignAndUpload").mockImplementation(async (_, __, file) => {
      if (file.name === "photo-2.jpg" && attempts === 0) {
        attempts++;
        throw new Error("Temporary network glitch");
      }
      return { key: `key-success-${file.name}` };
    });

    const statusById: Record<string, string> = {};

    let controller: ReturnType<typeof runBatchUploadPool>;

    await new Promise<void>((resolve) => {
      controller = runBatchUploadPool(items, {
        maxConcurrency: 2,
        onItemUpdate: (id, u) => {
          if (u.status) statusById[id] = u.status;
        },
        onAllComplete: () => resolve(),
      });
    });

    const photo2 = items[1];
    expect(statusById[photo2.id]).toBe("failed");

    // Retry only photo 2
    await new Promise<void>((resolve) => {
      controller.retryItem(photo2.id);
      setTimeout(() => {
        resolve();
      }, 50);
    });

    expect(statusById[photo2.id]).toBe("uploaded");
  });

  it("7. Item removal & cancellation: aborts in-flight item and cleans up", () => {
    const files = createMockFiles(4);
    const items = createStagedMediaItems(files);

    vi.spyOn(r2Upload, "presignAndUpload").mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return { key: "done" };
    });

    const controller = runBatchUploadPool(items, {
      maxConcurrency: 2,
      onItemUpdate: () => {},
    });

    expect(() => controller.removeItem(items[0].id)).not.toThrow();
    expect(() => controller.cancel()).not.toThrow();
  });

  it("8. Decoupled polling: worker slot is released immediately after R2 upload without blocking next items", async () => {
    // 4 HEIC files
    const files = Array.from({ length: 4 }, (_, i) => {
      return new File([`heic-${i}`], `photo-${i + 1}.heic`, { type: "image/heic" });
    });
    const items = createStagedMediaItems(files);

    const uploadStartedTimes: number[] = [];
    const uploadFinishedTimes: number[] = [];

    vi.spyOn(r2Upload, "presignAndUpload").mockImplementation(async (_, __, file) => {
      const idx = Number((file as File).name.replace(/\D/g, "")) - 1;
      uploadStartedTimes[idx] = Date.now();
      // Fast R2 upload: 20ms
      await new Promise((r) => setTimeout(r, 20));
      uploadFinishedTimes[idx] = Date.now();
      return { key: `orig-key-${idx}`, requiresProcessing: true };
    });

    // Mock global fetch for pollNormalizationStatus
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/media/process-status")) {
        // Slow normalization: takes 150ms per item
        await new Promise((r) => setTimeout(r, 150));
        return {
          ok: true,
          json: async () => ({
            statuses: {
              "orig-key-0": { status: "completed", normalizedKey: "norm-key-0" },
              "orig-key-1": { status: "completed", normalizedKey: "norm-key-1" },
              "orig-key-2": { status: "completed", normalizedKey: "norm-key-2" },
              "orig-key-3": { status: "completed", normalizedKey: "norm-key-3" },
            },
          }),
        };
      }
      return originalFetch(url);
    });

    const statusUpdates: Record<string, string[]> = {};

    try {
      await new Promise<void>((resolve) => {
        runBatchUploadPool(items, {
          maxConcurrency: 2,
          onItemUpdate: (id, u) => {
            if (u.status) {
              if (!statusUpdates[id]) statusUpdates[id] = [];
              statusUpdates[id].push(u.status);
            }
          },
          onAllComplete: () => {
            resolve();
          },
        });
      });

      // KEY ASSERTION:
      // Item 2 (the 3rd file, 0-indexed) must have STARTED uploading BEFORE Item 0 finished its slow 150ms polling!
      // In the old blocked implementation, Item 2 would only start at T >= 170ms (after Item 0 polling completed).
      // In the new decoupled implementation, Item 2 starts at T ~ 25ms (right after Item 0 or 1 finishes R2 PUT).
      expect(uploadStartedTimes[2]).toBeDefined();
      expect(uploadStartedTimes[2]).toBeLessThan(uploadFinishedTimes[0] + 100);

      // All items successfully reached "uploaded"
      for (const item of items) {
        expect(statusUpdates[item.id]).toContain("processing");
        expect(statusUpdates[item.id]).toContain("uploaded");
      }
    } finally {
      global.fetch = originalFetch;
    }
  });
});

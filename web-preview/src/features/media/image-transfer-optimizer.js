export const ImageTransferDefaults = Object.freeze({
  maximumInputBytes: 20 * 1024 * 1024,
  maximumDimension: 1_280,
  targetBytes: 192 * 1024
});

function webpFileName(fileName) {
  const base = String(fileName || "image").replace(/\.[^.]+$/, "");
  return `${base || "image"}.webp`;
}

function canvasBlob(canvas, mimeType, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("La compression de l’image a échoué")),
      mimeType,
      quality
    );
  });
}

function originalImage(file) {
  return {
    blob: file,
    fileName: file.name || "image",
    mimeType: file.type || "application/octet-stream",
    optimized: false
  };
}

export async function optimizeImageForTransfer(file, {
  maximumBytes,
  maximumInputBytes = ImageTransferDefaults.maximumInputBytes,
  maximumDimension = ImageTransferDefaults.maximumDimension,
  targetBytes = ImageTransferDefaults.targetBytes,
  createBitmap = globalThis.createImageBitmap,
  createCanvas = () => document.createElement("canvas")
} = {}) {
  if (!file?.size || !file.type?.startsWith("image/")) {
    throw new Error("Le fichier sélectionné n’est pas une image valide");
  }
  if (!maximumBytes) throw new Error("La limite d’image BitChat est absente");
  if (file.size > maximumInputBytes) {
    throw new Error(`Image source trop volumineuse — maximum ${Math.floor(maximumInputBytes / 1024 / 1024)} Mo`);
  }
  if (file.size <= Math.min(targetBytes, maximumBytes)) return originalImage(file);
  if (typeof createBitmap !== "function") {
    if (file.size <= maximumBytes) return originalImage(file);
    throw new Error("Ce navigateur ne peut pas optimiser cette image");
  }

  const bitmap = await createBitmap(file);
  try {
    const initialScale = Math.min(1, maximumDimension / Math.max(bitmap.width, bitmap.height));
    let width = Math.max(1, Math.round(bitmap.width * initialScale));
    let height = Math.max(1, Math.round(bitmap.height * initialScale));
    let best = null;

    for (let pass = 0; pass < 7; pass += 1) {
      const canvas = createCanvas();
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: true });
      if (!context) throw new Error("Le moteur d’image est indisponible");
      context.drawImage(bitmap, 0, 0, width, height);
      const quality = Math.max(0.5, 0.84 - pass * 0.06);
      const candidate = await canvasBlob(canvas, "image/webp", quality);
      if (!best || candidate.size < best.size) best = candidate;
      if (candidate.size <= Math.min(targetBytes, maximumBytes)) break;
      width = Math.max(1, Math.round(width * 0.82));
      height = Math.max(1, Math.round(height * 0.82));
    }

    if (!best || best.size > maximumBytes) {
      throw new Error(`Image encore trop volumineuse après optimisation — maximum ${Math.floor(maximumBytes / 1024)} Ko`);
    }
    return {
      blob: best,
      fileName: webpFileName(file.name),
      mimeType: "image/webp",
      optimized: true
    };
  } finally {
    bitmap.close?.();
  }
}

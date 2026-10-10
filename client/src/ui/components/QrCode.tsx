import { useMemo } from "react";
import qrcode from "qrcode-generator";
import styles from "./QrCode.module.css";

interface QrCodeProps {
  value: string;
  /** Rendered width/height in CSS pixels. */
  size?: number;
  /** Accessible name; defaults to a generic label. */
  label?: string;
  className?: string;
}

/**
 * Inline SVG QR code, generated entirely on-device (no network calls — the
 * encoded URL never leaves the machine through a third-party image API).
 *
 * The code is intentionally dark-on-light in every app theme: scanners need
 * the contrast, so it does not follow the theme palette.
 */
export function QrCode({ value, size = 168, label, className }: QrCodeProps) {
  const model = useMemo(() => {
    try {
      const qr = qrcode(0, "M");
      qr.addData(value);
      qr.make();
      const count = qr.getModuleCount();
      let path = "";
      for (let row = 0; row < count; row += 1) {
        for (let col = 0; col < count; col += 1) {
          if (qr.isDark(row, col)) path += `M${col} ${row}h1v1h-1z`;
        }
      }
      return { path, count };
    } catch {
      // An unencodable value should degrade to "no code" rather than crash
      // the sign-in surface.
      return null;
    }
  }, [value]);

  if (!model) return null;

  // Four-module quiet zone keeps phone cameras reliable at small sizes.
  const quiet = 4;
  const extent = model.count + quiet * 2;

  return (
    <svg
      className={`${styles.qr} ${className ?? ""}`}
      width={size}
      height={size}
      viewBox={`0 0 ${extent} ${extent}`}
      role="img"
      aria-label={label ?? "QR code"}
      shapeRendering="crispEdges"
    >
      <rect className={styles.background} x="0" y="0" width={extent} height={extent} rx="2" />
      <path className={styles.modules} d={model.path} transform={`translate(${quiet} ${quiet})`} />
    </svg>
  );
}

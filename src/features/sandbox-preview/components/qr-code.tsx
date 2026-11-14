import { QRCodeSVG } from "qrcode.react";

interface PreviewQrCodeProps {
  url: string;
  size?: number;
}

/**
 * QR code for the live preview URL. `marginSize` 4 is the spec's quiet zone;
 * level L keeps long URLs at the lowest (easiest to scan) version, and
 * qrcode.react boosts the level for free when the version has room.
 */
export const PreviewQrCode = ({ url, size = 150 }: PreviewQrCodeProps) => (
  <QRCodeSVG
    value={url}
    size={size}
    level="L"
    marginSize={4}
    title={`QR code for ${url}`}
  />
);

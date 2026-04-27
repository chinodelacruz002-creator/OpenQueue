import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

type PublicQueueQrProps = {
  url: string;
  caption?: string;
};

/**
 * Renders a scannable code so players can open the public queue on their own phone
 * without retyping the URL.
 */
export const PublicQueueQr = ({
  url,
  caption = 'Scan to open the player queue on your phone',
}: PublicQueueQrProps) => {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void QRCode.toDataURL(url, {
      width: 180,
      margin: 1,
      color: { dark: '#0f172a', light: '#ffffff' },
    })
      .then((data) => {
        if (active) {
          setDataUrl(data);
        }
      })
      .catch(() => {
        if (active) {
          setDataUrl(null);
        }
      });
    return () => {
      active = false;
    };
  }, [url]);

  return (
    <div className="public-queue-qr" role="region" aria-label={caption}>
      {dataUrl ? (
        <img
          className="public-queue-qr__img"
          src={dataUrl}
          width={180}
          height={180}
          alt=""
        />
      ) : (
        <div className="public-queue-qr__placeholder" aria-hidden>
          <span className="public-queue-qr__spinner" />
        </div>
      )}
      <p className="public-queue-qr__caption">{caption}</p>
      <p className="public-queue-qr__url">
        <a href={url}>{url}</a>
      </p>
    </div>
  );
};

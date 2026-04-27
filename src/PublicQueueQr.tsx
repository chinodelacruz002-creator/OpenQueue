import { useState } from 'react';

const qrImageUrl = (data: string) =>
  `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(
    data,
  )}&margin=1`;

type PublicQueueQrProps = {
  url: string;
  caption?: string;
};

/**
 * Renders a scannable code so players can open the public queue on their own phone
 * without retyping the URL. The image is provided by a public QR service (link below still works offline).
 */
export const PublicQueueQr = ({
  url,
  caption = 'Scan to open the player queue on your phone',
}: PublicQueueQrProps) => {
  const [imageFailed, setImageFailed] = useState(false);

  return (
    <div className="public-queue-qr" role="region" aria-label={caption}>
      {!imageFailed ? (
        <img
          className="public-queue-qr__img"
          src={qrImageUrl(url)}
          width={180}
          height={180}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => {
            setImageFailed(true);
          }}
        />
      ) : (
        <div className="public-queue-qr__placeholder" aria-hidden>
          <p className="public-queue-qr__fallback">QR image unavailable. Use the link below.</p>
        </div>
      )}
      <p className="public-queue-qr__caption">{caption}</p>
      <p className="public-queue-qr__url">
        <a href={url}>{url}</a>
      </p>
    </div>
  );
};

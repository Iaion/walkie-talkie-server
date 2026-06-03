/** Detalle de una verificación: datos, flags antifraude, fotos (URLs firmadas) y aprobar/rechazar. */
import { useEffect, useState } from 'react';
import { adminApi, type Verification } from '../api';

interface Props {
  verification: Verification;
  onBack: () => void;
  onReviewed: () => void;
}

export function VerificationDetail({ verification, onBack, onReviewed }: Props) {
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    adminApi
      .getPhotos(verification.uid)
      .then((r) => setPhotos(r.photos || {}))
      .catch(() => setPhotos({}));
  }, [verification.uid]);

  const doApprove = async () => {
    setBusy(true);
    setError('');
    try {
      await adminApi.approve(verification.uid);
      onReviewed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al aprobar');
    } finally {
      setBusy(false);
    }
  };

  const doReject = async () => {
    if (!reason.trim()) {
      setError('Indicá un motivo de rechazo');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await adminApi.reject(verification.uid, reason);
      onReviewed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al rechazar');
    } finally {
      setBusy(false);
    }
  };

  const v = verification;
  return (
    <div className="detail">
      <button className="back" onClick={onBack}>
        ← Volver a la cola
      </button>
      <h2>{v.fullName || v.uid}</h2>
      <dl>
        <dt>Tipo de cuenta</dt>
        <dd>{v.accountType}</dd>
        <dt>Documento</dt>
        <dd>{v.documentNumber || '—'}</dd>
        <dt>Teléfono</dt>
        <dd>{v.phone || '—'}</dd>
        {v.titular && (
          <>
            <dt>Titular declarado</dt>
            <dd>
              {v.titular.name} ({v.titular.document}) · cuenta {v.titular.accountId}
            </dd>
          </>
        )}
      </dl>

      {v.flags && v.flags.length > 0 && (
        <ul className="flags">
          {v.flags.map((f) => (
            <li key={f.code}>⚠ {f.message}</li>
          ))}
        </ul>
      )}

      <div className="photos">
        {Object.entries(photos).length === 0 && <p>Sin fotos disponibles.</p>}
        {Object.entries(photos).map(([key, url]) => (
          <figure key={key}>
            <a href={url} target="_blank" rel="noreferrer">
              <img src={url} alt={key} />
            </a>
            <figcaption>{key}</figcaption>
          </figure>
        ))}
      </div>

      {error && <p className="error">{error}</p>}

      {v.status === 'pending_review' ? (
        <div className="actions">
          <button className="approve" onClick={doApprove} disabled={busy}>
            ✅ Aprobar
          </button>
          <input
            placeholder="Motivo de rechazo"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button className="reject" onClick={doReject} disabled={busy}>
            ❌ Rechazar
          </button>
        </div>
      ) : (
        <p className={`status-pill ${v.status}`}>
          {v.status === 'approved' ? '✅ Aprobada' : v.status === 'rejected' ? '❌ Rechazada' : v.status}
        </p>
      )}
    </div>
  );
}

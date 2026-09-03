/** Detalle de una verificación: datos, flags antifraude, fotos (URLs firmadas) y aprobar/rechazar.
 *  Con feedback de acciones por toast (G3) y estado de carga de fotos. */
import { useEffect, useState } from 'react';
import { adminApi, type Verification } from '../api';
import { useToast } from '../toast/ToastContext';

interface Props {
  verification: Verification;
  onBack: () => void;
  onReviewed: () => void;
}

const MAX_REASON_LENGTH = 500;

/** Nombres legibles de cada foto (las claves crudas de la API no se muestran al usuario). */
const PHOTO_LABELS: Record<string, string> = {
  selfieUrl: 'Selfie',
  documentUrl: 'Documento',
  deliveryAppScreenshotUrl: 'App de delivery',
  renterFaceUrl: 'Cara del alquilador',
  workPhonePhotoUrl: 'Teléfono de trabajo',
};
const photoLabel = (key: string) => PHOTO_LABELS[key] || key.replace(/Url$/, '');

export function VerificationDetail({ verification, onBack, onReviewed }: Props) {
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const [photosLoading, setPhotosLoading] = useState(true);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { showToast } = useToast();

  useEffect(() => {
    setPhotosLoading(true);
    adminApi
      .getPhotos(verification.uid)
      .then((r) => setPhotos(r.photos || {}))
      .catch(() => setPhotos({}))
      .finally(() => setPhotosLoading(false));
  }, [verification.uid]);

  const doApprove = async () => {
    setBusy(true);
    setError('');
    try {
      await adminApi.approve(verification.uid);
      showToast('success', `Verificación de ${verification.fullName || verification.uid} aprobada`);
      onReviewed();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error al aprobar';
      setError(msg);
      showToast('error', msg);
    } finally {
      setBusy(false);
    }
  };

  const doReject = async () => {
    if (!reason.trim()) {
      setError('Indicá un motivo de rechazo');
      return;
    }
    if (reason.length > MAX_REASON_LENGTH) {
      setError(`El motivo no puede superar los ${MAX_REASON_LENGTH} caracteres`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await adminApi.reject(verification.uid, reason.trim());
      showToast('success', `Verificación de ${verification.fullName || verification.uid} rechazada`);
      onReviewed();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error al rechazar';
      setError(msg);
      showToast('error', msg);
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
        <dd>{v.accountType === 'owner' ? 'Titular de la cuenta' : 'Alquila la cuenta'}</dd>
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
        {photosLoading && <p>Cargando fotos…</p>}
        {!photosLoading && Object.entries(photos).length === 0 && <p>Sin fotos disponibles.</p>}
        {Object.entries(photos).map(([key, url]) => (
          <figure key={key}>
            <a href={url} target="_blank" rel="noreferrer">
              <img src={url} alt={`Foto: ${photoLabel(key)}`} />
            </a>
            <figcaption>{photoLabel(key)}</figcaption>
          </figure>
        ))}
      </div>

      {error && <p className="error">{error}</p>}

      {v.status === 'pending_review' ? (
        <div className="actions">
          <button className="approve" onClick={doApprove} disabled={busy} aria-label="Aprobar verificación">
            ✅ Aprobar
          </button>
          <label htmlFor="reject-reason" className="visually-hidden">
            Motivo de rechazo
          </label>
          <input
            id="reject-reason"
            placeholder="Motivo de rechazo"
            maxLength={MAX_REASON_LENGTH}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button className="reject" onClick={doReject} disabled={busy} aria-label="Rechazar verificación">
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

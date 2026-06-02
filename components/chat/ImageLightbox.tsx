'use client'

import { useEffect } from 'react'
import { X } from 'lucide-react'

interface Props {
  src:     string
  alt?:    string
  onClose: () => void
}

export default function ImageLightbox({ src, alt = 'Imagem', onClose }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    /* Portal não necessário: fixed escapa qualquer overflow/transform pai */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
      onClick={onClose}
    >
      {/* Botão fechar */}
      <button
        className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/25 text-white/70 hover:text-white transition-colors"
        onClick={onClose}
        aria-label="Fechar"
      >
        <X className="w-6 h-6" />
      </button>

      {/* Imagem — clique não fecha */}
      <img
        src={src}
        alt={alt}
        className="max-w-[92vw] max-h-[92vh] object-contain rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
}

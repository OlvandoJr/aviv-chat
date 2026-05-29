import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title:       'Aviv Chat',
  description: 'Plataforma de atendimento WhatsApp',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className="h-full">
      <body className="h-full bg-white antialiased">{children}</body>
    </html>
  )
}

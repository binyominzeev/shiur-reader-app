import type { Metadata, Viewport } from 'next'
import ServiceWorkerRegistration from '@/components/ServiceWorkerRegistration'
import './globals.css'

export const metadata: Metadata = {
  title: 'Shiur Reader',
  description: 'Quickly read the beginning of long MP3 recordings without listening',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Shiur Reader',
  },
}

export const viewport: Viewport = {
  themeColor: '#3b82f6',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50 text-gray-900 antialiased">
        <ServiceWorkerRegistration />
        {children}
      </body>
    </html>
  )
}

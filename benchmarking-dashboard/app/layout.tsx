import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PayFlow Evaluation',
  description: 'Local dashboard for isolated PayFlow candidate runs.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

import type { ReactNode } from 'react';

export const metadata = {
  title: 'Scheduler workspace',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'IncidentOS',
  description: 'Autonomous SRE Incident Command System',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav>
          <div className="container">
            <a href="/" className="brand">Incident<span>OS</span></a>
            <span style={{ color: '#4b5563', fontSize: 12 }}>Autonomous SRE Incident Command</span>
          </div>
        </nav>
        <main className="container" style={{ paddingTop: 8, paddingBottom: 40 }}>
          {children}
        </main>
      </body>
    </html>
  );
}

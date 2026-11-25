import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import RootLayout, { metadata } from './layout';
import HomePage from './page';

describe('scheduler workspace placeholder', () => {
  it('renders the workspace heading', () => {
    expect(renderToStaticMarkup(<HomePage />)).toContain('Scheduler workspace');
  });

  it('wraps pages in an English document', () => {
    const html = renderToStaticMarkup(
      <RootLayout>
        <p>child</p>
      </RootLayout>,
    );
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('child');
    expect(metadata.title).toBe('Scheduler workspace');
  });
});

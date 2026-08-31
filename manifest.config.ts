import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'Po-Cake',
  version: '0.1.0',
  description: 'No-code E2E test recorder — accessibility-based selectors + CDP trusted-event replay.',
  action: {
    default_title: 'Po-Cake — open test recorder',
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  side_panel: {
    default_path: 'index.html',
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
      all_frames: false,
    },
  ],
  permissions: ['sidePanel', 'debugger', 'scripting', 'tabs', 'activeTab', 'storage'],
  host_permissions: ['<all_urls>'],
});

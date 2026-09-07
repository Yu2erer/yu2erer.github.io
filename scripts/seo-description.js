/* global hexo */
'use strict';

const openGraph = hexo.extend.helper.get('open_graph');

// Pass SEO text only to the metadata helper, leaving NexT's visible excerpt alone.
hexo.extend.helper.register('open_graph', function(options = {}) {
  const description = this.page && this.page.seo_description;
  if (options.description == null && typeof description === 'string' && description.trim()) {
    return openGraph.call(this, { ...options, description: description.trim() });
  }
  return openGraph.call(this, options);
});

// Find, inspect and read files and documents inside the user's folders (changes with undo come in files.js too).
const { createFilesTools } = require('../../tools/files');
const { own } = require('../util');

function createGroup({ pc } = {}) {
  if (!pc || !Array.isArray(pc.roots) || !pc.roots.length) return null;
  return {
    id: 'files',
    label: 'Find, read and inspect files and documents (recent, big, text inside, PDF, Word)',
    triggers: [
      { re: /\b(?:recent|big|large|largest|biggest) files?\b|\bdisk space\b|\bhow big is\b|\bsearch (?:my |the )?files\b|\bin my files\b/i, w: 3 },
      { re: /\b(?:read) (?:this |the |that |my )?(?:pdf|doc(?:ument|x)?|file)\b|\bsummari[sz]e (?:the |this |that |my )?(?:file|pdf|doc(?:ument|x)?)\b/i, w: 3 },
      { re: /\bfind (?:the |my |a )?(?:\w+ )?(?:pdf|docx?|document|spreadsheet)s?\b|\b(?:downloaded|modified|changed|created) (?:today|yesterday|this week|recently|last week)\b/i, w: 3 },
      { words: ['file', 'files', 'folder', 'folders', 'pdf', 'pdfs', 'docx'], w: 1 },
    ],
    tools: createFilesTools(pc).map(t => own(t)),
  };
}

module.exports = { createGroup };

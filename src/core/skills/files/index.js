// Find, inspect and read files and documents inside the user's folders (changes with undo come in files.js too).
const { createFilesTools } = require('../../tools/files');
const { own } = require('../util');

function createGroup({ pc } = {}) {
  if (!pc || !Array.isArray(pc.roots) || !pc.roots.length) return null;
  return {
    id: 'files',
    label: 'Find, read and inspect files and documents (recent, big, text inside, PDF, Word); rename, sort, copy, zip, unzip, new folders',
    triggers: [
      { re: /\b(?:recent|big|large|largest|biggest) files?\b|\bdisk space\b|\bhow big is\b|\bsearch (?:my |the )?files\b|\bin my files\b/i, w: 3 },
      { re: /\b(?:read) (?:this |the |that |my )?(?:pdf|doc(?:ument|x)?|file)\b|\bsummari[sz]e (?:the |this |that |my )?(?:file|pdf|doc(?:ument|x)?)\b/i, w: 3 },
      { re: /\bfind (?:the |my |a )?(?:\w+ )?(?:pdf|docx?|document|spreadsheet)s?\b|\b(?:downloaded|modified|changed|created) (?:today|yesterday|this week|recently|last week)\b/i, w: 3 },
      { re: /\b(?:rename|organi[sz]e|zip|unzip|unpack|extract|compress|sort)\b.*\b(?:files?|folders?|downloads|desktop|documents|pictures|photos|pdfs?)\b|\b(?:zip|unzip|unpack)\b|\b(?:make|create|new) (?:a |an )?(?:new )?folder\b|\bcopy (?:the |these |my )?files?\b|\bbulk rename\b/i, w: 3 },
      { words: ['file', 'files', 'folder', 'folders', 'pdf', 'pdfs', 'docx', 'rename'], w: 1 },
    ],
    tools: createFilesTools(pc).map(t => own(t)),
  };
}

module.exports = { createGroup };

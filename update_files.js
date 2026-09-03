const fs = require('fs');

function replaceFile(path, searchRegex, replacement) {
  if (fs.existsSync(path)) {
    let content = fs.readFileSync(path, 'utf8');
    content = content.replace(searchRegex, replacement);
    fs.writeFileSync(path, content);
    console.log('Updated ' + path);
  }
}

// 1. analytics.service.ts
replaceFile(
  'd:/HYD/RRH PWA/apps/api/src/services/analytics.service.ts',
  /'CONTACTED', 'QUALIFICATION_PENDING', 'QUALIFIED'/g,
  "'CONTACTED', 'QUALIFIED'"
);

// 2. lead.service.ts
replaceFile(
  'd:/HYD/RRH PWA/apps/api/src/services/lead.service.ts',
  /'CONTACTED', 'QUALIFICATION_PENDING', 'QUALIFIED'/g,
  "'CONTACTED', 'QUALIFIED'"
);

// 3. lead.policy.ts
replaceFile(
  'd:/HYD/RRH PWA/apps/api/src/policies/lead.policy.ts',
  /CONTACTED: \['QUALIFICATION_PENDING', 'QUALIFIED', 'DROPPED'\],\s*QUALIFICATION_PENDING: \['QUALIFIED', 'DROPPED'\],/g,
  "CONTACTED: ['QUALIFIED', 'DROPPED'],"
);

// 4. schema.prisma
replaceFile(
  'd:/HYD/RRH PWA/apps/api/prisma/schema.prisma',
  /NEW, ASSIGNED, CONTACTED, QUALIFICATION_PENDING, QUALIFIED/g,
  "NEW, ASSIGNED, CONTACTED, QUALIFIED"
);

// 5. e2e-crm-lifecycle.test.ts
replaceFile(
  'd:/HYD/RRH PWA/tests/api/e2e-crm-lifecycle.test.ts',
  /status: 'QUALIFICATION_PENDING'/g,
  "status: 'QUALIFIED'" // For the test, it's likely advancing to qualified
);

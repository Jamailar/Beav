const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { ulid } = require('ulid');

const TEST_FILE = 'test_manuscript.md';
const TEST_CONTENT = '# Hello World\n\nThis is a test.';

async function runTest() {
    console.log('--- Starting Verification ---');

    // 1. Create a raw markdown file without frontmatter
    fs.writeFileSync(TEST_FILE, TEST_CONTENT);
    console.log('1. Created raw file:', TEST_FILE);

    // 2. Simulate manuscripts:read (Inject ID)
    console.log('2. Simulating manuscripts:read...');
    const rawContent = fs.readFileSync(TEST_FILE, 'utf-8');
    const parsed = matter(rawContent);
    let { data, content } = parsed;

    if (!data.id) {
        console.log('   - ID missing, generating...');
        data.id = ulid();
        data.createdAt = new Date().toISOString();
        const newContent = matter.stringify(content, data);
        fs.writeFileSync(TEST_FILE, newContent);
        console.log('   - File updated with frontmatter.');
    }

    // 3. Verify Frontmatter existence
    const contentWithFrontmatter = fs.readFileSync(TEST_FILE, 'utf-8');
    console.log('3. Content after read:\n', contentWithFrontmatter);
    if (contentWithFrontmatter.includes('id:')) {
        console.log('   [PASS] Frontmatter ID found.');
    } else {
        console.error('   [FAIL] Frontmatter ID NOT found.');
    }

    // 4. Simulate manuscripts:save (Update content & timestamp)
    console.log('4. Simulating manuscripts:save...');
    // Read again to get current metadata
    const currentParsed = matter(contentWithFrontmatter);
    const newBody = '# Hello World\n\nUpdated content.';
    const metadata = currentParsed.data;
    metadata.updatedAt = new Date().toISOString();

    const finalContent = matter.stringify(newBody, metadata);
    fs.writeFileSync(TEST_FILE, finalContent);

    // 5. Verify persistence
    const finalFileContent = fs.readFileSync(TEST_FILE, 'utf-8');
    console.log('5. Final Content:\n', finalFileContent);

    if (finalFileContent.includes('updatedAt:') && finalFileContent.includes(metadata.id) && finalFileContent.includes('Updated content')) {
         console.log('   [PASS] content updated, metadata preserved/updated.');
    } else {
         console.error('   [FAIL] Save verification failed.');
    }

    // 6. Cleanup
    fs.unlinkSync(TEST_FILE);
    console.log('6. Cleanup done.');
}

runTest().catch(console.error);

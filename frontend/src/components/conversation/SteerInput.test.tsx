import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import SteerInput, { resolvePromptInputEnterBehavior } from './SteerInput.tsx';

test('SteerInput shows a spinner while a message is being sent', () => {
  const html = renderToStaticMarkup(
    <SteerInput
      value="Continue with Europe"
      onChange={() => undefined}
      onSubmit={() => undefined}
      disabled={false}
      isSending
      error={null}
      datasetError={null}
      uploadedDatasetName={null}
      uploadedDatasetSizeBytes={null}
      isUploadingDataset={false}
    />
  );

  assert.match(html, /animate-spin/);
  assert.doesNotMatch(html, /-rotate-90/);
  assert.doesNotMatch(html, /pl-14/);
  assert.doesNotMatch(html, /absolute bottom-3 left-3/);
  assert.match(html, /data-steer-control-row="true"/);
  assert.match(html, /min-h-\[84px\]/);
  assert.match(html, /data-steer-control-row="true"[^>]*class="[^"]*pb-2/);
});

test('SteerInput shows an embedded CSV upload affordance in new-conversation mode', () => {
  const html = renderToStaticMarkup(
    <SteerInput
      value="Start the analysis"
      onChange={() => undefined}
      onSubmit={() => undefined}
      disabled={false}
      isSending={false}
      error={null}
      mode="new"
      datasetPath="data/vgsales.csv"
      onDatasetPathChange={() => undefined}
      onUploadDataset={() => undefined}
      datasetError={null}
      uploadedDatasetName="upload.csv"
      uploadedDatasetSizeBytes={1024}
      isUploadingDataset={false}
    />
  );

  assert.match(html, /Upload CSV/);
  assert.match(html, /data-steer-upload-button="true"/);
  assert.match(html, /data-steer-control-row="true"/);
  assert.match(html, /data-steer-upload-button="true"[^>]*class="[^"]*bg-slate-800[^"]*text-white/);
  assert.doesNotMatch(html, /Dataset Source/);
  assert.doesNotMatch(html, /value="data\/vgsales\.csv"/);
  assert.doesNotMatch(html, /pl-14/);
  assert.match(html, /Selected file:\s*<span[^>]*>upload\.csv<\/span>/);
});

test('SteerInput keeps the upload button visible but disabled in run mode', () => {
  const html = renderToStaticMarkup(
    <SteerInput
      value="Continue the analysis"
      onChange={() => undefined}
      onSubmit={() => undefined}
      disabled={false}
      isSending={false}
      error={null}
      mode="run"
      datasetPath="/abs/path/upload.csv"
      onDatasetPathChange={() => undefined}
      onUploadDataset={() => undefined}
      datasetError={null}
      uploadedDatasetName="upload.csv"
      uploadedDatasetSizeBytes={1024}
      isUploadingDataset={false}
      lockDatasetSource
      preserveDatasetSourceStyle
    />
  );

  assert.match(html, /Upload CSV/);
  assert.match(html, /data-steer-upload-button="true"[^>]*disabled=""/);
  assert.match(html, /data-steer-control-row="true"/);
  assert.match(html, /data-steer-upload-button="true"[^>]*class="[^"]*bg-slate-800[^"]*text-white/);
  assert.doesNotMatch(html, /Dataset Source/);
  assert.match(html, /Selected file:\s*<span[^>]*>upload\.csv<\/span>/);
});

test('SteerInput renders dataset errors below the composer without the dataset panel', () => {
  const html = renderToStaticMarkup(
    <SteerInput
      value="Start the analysis"
      onChange={() => undefined}
      onSubmit={() => undefined}
      disabled={false}
      isSending={false}
      error={null}
      mode="new"
      datasetPath="data/vgsales.csv"
      onDatasetPathChange={() => undefined}
      onUploadDataset={() => undefined}
      datasetError="Failed to upload dataset"
      uploadedDatasetName={null}
      uploadedDatasetSizeBytes={null}
      isUploadingDataset={false}
    />
  );

  assert.doesNotMatch(html, /Dataset Source/);
  assert.match(html, />Failed to upload dataset<\/div>/);
});

test('SteerInput prompt Enter behavior sends only on plain Enter', () => {
  assert.equal(
    resolvePromptInputEnterBehavior({
      key: 'Enter',
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
    }),
    'submit'
  );
  assert.equal(
    resolvePromptInputEnterBehavior({
      key: 'Enter',
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
    }),
    'newline'
  );
  assert.equal(
    resolvePromptInputEnterBehavior({
      key: 'Enter',
      shiftKey: false,
      ctrlKey: true,
      metaKey: false,
      altKey: false,
    }),
    'newline'
  );
  assert.equal(
    resolvePromptInputEnterBehavior({
      key: 'Enter',
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      isComposing: true,
    }),
    'ignore'
  );
  assert.equal(
    resolvePromptInputEnterBehavior({
      key: 'a',
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
    }),
    'ignore'
  );
});

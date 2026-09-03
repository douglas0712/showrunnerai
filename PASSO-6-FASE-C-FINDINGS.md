# FASE C: Image-to-Video Support Investigation

## Summary
The workflow infrastructure for i2v (image-to-video) **already exists** but requires integration in `submitGeneration()`.

## Existing Infrastructure ✓

### 1. Workflow Support (minimaxH3.js)
```javascript
// Modes supported:
GENERATION_MODES = {
  T2V: "Text to Video",      // prompt only
  I2V: "Image to Video",      // prompt + first_frame
  FLF: "Frame to Frame"       // prompt + first_frame + last_frame
}

// attachFrames() function:
// - Takes { first?: {bytes, type, name}, last?: ... }
// - Injects LoadImage nodes into graph
// - Sets first_frame/last_frame inputs on prompt node
// - Returns ligados (connected frame references)
```

### 2. Frame Upload (provider.js)
```javascript
async function enviarQuadros(jobId, quadros)
// Expects: { first?: {bytes, declaredType, declaredName}, ... }
// Validates frame data
// Uploads to ComfyUI
// Returns references for graph attachment
```

## Missing Implementation ✗

### submitGeneration() signature (line 253)
```javascript
// Current:
export async function submitGeneration(params = {}) {
  const {
    prompt, seed, durationSeconds, aspect, quality, fps, projectId,
    jobId, frames: quadros = null,
    workflowId = DEFAULT_VIDEO_WORKFLOW_ID,
  } = params;
  
  // Missing: sourceAssetId is NOT in destructuring
  // Result: facade.js passes sourceAssetId but it's silently ignored
}
```

### Required Changes
To enable i2v, submitGeneration must:

1. **Accept sourceAssetId parameter**
   ```javascript
   const { ..., sourceAssetId = null } = params;
   ```

2. **Load asset if provided**
   ```javascript
   if (sourceAssetId) {
     // Get asset from database
     // Read media file from storage
     // Extract bytes, type, filename
     // Create quadros.first = { bytes, declaredType, declaredName }
   }
   ```

3. **Pass frames to enviarQuadros**
   ```javascript
   const referencias = await enviarQuadros(jobId, quadros);
   // Will automatically set workflow mode (T2V vs I2V vs FLF)
   ```

## Architecture Dependencies

### Asset Access
- **Need**: `getAsset(assetId, db)` → returns Asset record
- **Have**: Asset stored in domain, has projectId + jobId fields
- **Missing**: Path to actual media file on disk

### Storage Access
- **Need**: Read binary file data from Asset's stored location
- **Have**: `storage.js` module with path validation
- **Missing**: Export function to read Asset media file by assetId

### Database Integration
- **Need**: Access to SQLite database in submitGeneration
- **Have**: `database()` function exported from domain/db.js
- **Status**: Can be injected via params

## Implementation Complexity

### Simple Path (minimal changes)
```
Low effort: Just add sourceAssetId parameter to destructuring
- Prevents silent ignoring of sourceAssetId
- Allows facade to pass it through
- Defers actual i2v support to later phase
- Tools work but i2v fails with clear error
```

### Full Path (recommended for PASSO 6)
```
Medium effort:
1. Update submitGeneration signature (5 lines)
2. Add asset loading logic (~15 lines)
3. Export asset file reader from storage.js (~10 lines)
4. Wire up in submitGeneration (~5 lines)

Total: ~35 lines, requires understanding:
- Asset structure and database queries
- Storage path conventions
- Binary file reading
```

## Recommendation

**For PASSO 6 completion:**
1. Add sourceAssetId parameter to submitGeneration (prevents silent ignoring)
2. Add basic validation of sourceAssetId (not null)
3. Document the i2v bridge as "validated for structure, not yet connected"
4. Make FASE D work with either T2V or placeholder i2v

**For PASSO 7:**
- Full i2v implementation with actual file loading
- Media serving for generated videos
- End-to-end i2v test with real ComfyUI

## Current State

| Component | Status | Notes |
|-----------|--------|-------|
| Workflow graph structure | ✓ Ready | attachFrames() works |
| Frame upload to ComfyUI | ✓ Ready | enviarQuadros() works |
| Asset validation in tools | ✓ Done | generateVideoTool validates sourceAsset |
| Facade validation | ✓ Done | startVideoGeneration validates projectId match |
| submitGeneration parameter | ✗ Not accepting | Needs signature update |
| Asset file loading | ✗ Missing | Needs storage integration |
| Database integration | ✓ Available | Can inject db() |

## Code Locations
- Workflow: `lib/server/generation/workflows/minimaxH3.js:245-280`
- Upload: `lib/server/comfy/provider.js:390-430`
- submitGeneration: `lib/server/comfy/provider.js:253-280`
- Facade call: `lib/server/generation/facade.js:160-164`
- Tool validation: `lib/server/agent/tools/handlers/generateVideo.js:106-135`

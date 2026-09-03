# Passo 6: Showrunner Agent Tools - Status Report

## Completed Phases

### FASE A: Tool Registry & Input Validation ✓
- Implemented three native tools: `og.generate_image`, `og.generate_video`, `og.get_job`
- Added strict input validation with unknown property rejection
- Fixed Tool Registry with safe-by-construction public API
  - `publicToolList()` strips execute handlers for runtime consumption
  - Internal `invoke()` is the only execution pathway
- All handlers validate context (threadId, projectId required)
- Proper ToolExecutionError formatting with detail objects

### FASE E: Facade Import Cleanup ✓
- Moved generation facade to static imports (no dynamic requires)
- Fixed getJob import source: `comfy/jobs.js` not `provider.js`
- Removed redundant dynamic imports of getAsset and findAssetsByJob
- All import paths corrected for handler locations

### FASE F: Comprehensive Test Suite ✓
- 46 test cases covering:
  - og.generate_image: 12 tests (context, validation, edge cases)
  - og.generate_video: 13 tests (context, validation, duration/seed constraints)
  - og.get_job: 8 tests (context, validation, jobId requirements)
  - Tool Registry: 9 tests (registration, lookup, public API)
  - Error classes: 3 tests
- All tests passing
- Validates input validation without requiring facade mocks

## Remaining Phases

### FASE C: Investigate i2v Support
**Status**: Needs investigation  
**Issue**: `submitGeneration()` doesn't handle `sourceAssetId` parameter
- Facade passes `sourceAssetId` to submitGeneration (line 163)
- Provider's submitGeneration ignores it (not in params destructuring)
- Need to:
  1. Add `sourceAssetId` to submitGeneration signature
  2. Implement logic to load asset file from storage
  3. Patch workflow graph to use start frame instead of text-only input
  4. Distinguish t2v (text-to-video) from i2v (image-to-video) workflows

### FASE D: Asset Finalizer
**Status**: Blocked on FASE C verification  
**Purpose**: Idempotent job completion with database constraints
**Requirements**:
- On job completion: fetch Asset by jobId
- Create Asset if not exists (with idempotent properties)
- Store mediaUrl, derive lineage (derivedFromAssetId for i2v)
- Prevent duplicate Assets per job

### FASE G: Gateway Integration
**Status**: Design ready, awaiting execution  
**Scope**:
- Connect AgentGateway.sendMessage() to tool execution
- Prepare callable tools from publicToolList
- Format tool results in event stream
- Integrate with existing event normalization

### FASE H: Smoke Test
**Status**: Awaiting implementation of D/G  
**Coverage**:
- End-to-end workflow if ComfyUI available
- Tool execution through Gateway
- Asset creation and persistence
- Error handling in production paths

## Architecture Notes

### Security Boundaries
- ToolContext (threadId, projectId, signal) is trusted
- projectId never comes from handler args—always from context
- Tools cannot access handlers directly, only through registry.invoke()
- publicToolList strips execute to prevent runtime access

### Import Hierarchy
```
handlers/*.js
  ├─→ facade.js (high-level generation API)
  ├─→ comfy/jobs.js (job state)
  ├─→ domain/index.js (assets, projects)
  └─→ schema.js (error classes)

registry.js
  ├─→ handlers/*.js
  └─→ schema.js

index.js (entry point)
  ├─→ registry.js
  ├─→ handlers/*.js
  └─→ Re-exports: registry, publicToolList, error classes
```

### Database State Assumptions
- Jobs created by submitGeneration with projectId
- Job.status in: PREPARING, RUNNING, DONE, FAILED, SAVING
- Assets store kind (image/video), jobId, projectId, url
- derivedFromAssetId tracks i2v lineage

## Test Coverage Summary
```
og.generate_image:        12/12 ✓
  - Context validation (threadId, projectId)
  - Prompt validation (required, max 4000)
  - Optional params (aspect string, seed integer ≥0)
  - Unknown property rejection
  
og.generate_video:        13/13 ✓
  - Context validation
  - Prompt validation
  - Duration validation (1-20 seconds)
  - Seed validation
  - sourceAssetId string validation
  - Unknown property rejection
  
og.get_job:               8/8 ✓
  - Context validation
  - jobId validation (required, non-empty string)
  - Unknown property rejection
  
Tool Registry:            9/9 ✓
  - Tool registration and lookup
  - Duplicate detection
  - Public API stripping execute
  - invoke() error handling
  
Error Classes:            3/3 ✓
  - ToolExecutionError with detail
  - ToolNotFoundError
  - DuplicateToolError

Total: 46/46 ✓
```

## Files Created/Modified
```
lib/server/agent/tools/
  ├─ schema.js (tool descriptors)
  ├─ registry.js (registry + public list)
  ├─ index.js (entry point)
  └─ handlers/
      ├─ generateImage.js
      ├─ generateVideo.js
      └─ getJob.js

lib/server/generation/
  └─ facade.js (high-level generation API)

tests/
  └─ agent-tools.test.mjs (46 tests)
```

## Next Steps (Recommended Order)
1. **FASE C**: Verify i2v support in provider.js
2. **FASE D**: Implement Asset finalizer
3. **FASE G**: Integrate Gateway with registry
4. **FASE H**: Smoke test if ComfyUI available
5. Create PASSO 7 integration tests

## Known Blockers
- None—all input validation tests pass
- i2v implementation deferred but not blocking tool invocation
- Asset finalizer can use placeholder storage until full implementation

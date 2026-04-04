export const MERIDIAN_TOOL_ENTRYPOINT = "src/bin/meridian-tool.ts";
export const LOCAL_TSX_RELATIVE_PATH = "./node_modules/.bin/tsx";
export const LOCAL_TSX_EXECUTABLE = `${process.cwd()}/node_modules/.bin/tsx`;
export const MERIDIAN_TOOL_COMMAND = `mkdir -p .tmp && TMPDIR=$PWD/.tmp ${LOCAL_TSX_RELATIVE_PATH} ${MERIDIAN_TOOL_ENTRYPOINT}`;

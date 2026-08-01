const sharp = require("sharp");
const MAX_SHAPE_SIZE = 5;
const MAX_PIECE_BLOCKS = 9;

async function detectPieces(imageBuffer, boardLocation) {
  validateBoardLocation(boardLocation);
  const { data, info } = await sharp(imageBuffer)
    .rotate()
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const boardCellSize =
    (boardLocation.width / 8 + boardLocation.height / 8) / 2;
  const expectedPieceCellSize = boardCellSize * 0.49;
  const trayLeft = clamp(
    Math.round(boardLocation.left - boardCellSize * 0.18),
    0,
    info.width,
  );
  const trayRight = clamp(
    Math.round(boardLocation.right + boardCellSize * 0.18),
    0,
    info.width,
  );
  const trayTop = clamp(
    Math.round(boardLocation.bottom + boardCellSize * 0.4),
    0,
    info.height,
  );
  const trayBottom = clamp(
    Math.round(
      Math.min(info.height * 0.9, boardLocation.bottom + boardCellSize * 4.8),
    ),
    0,
    info.height,
  );
  if (trayRight <= trayLeft || trayBottom <= trayTop)
    throw new Error("The piece tray bounds were invalid");
  const trayWidth = trayRight - trayLeft;
  const details = [];
  for (let pieceIndex = 0; pieceIndex < 3; pieceIndex++) {
    const slotLeft = Math.round(trayLeft + (trayWidth * pieceIndex) / 3);
    const slotRight = Math.round(trayLeft + (trayWidth * (pieceIndex + 1)) / 3);
    const slotInset = Math.max(1, Math.round((slotRight - slotLeft) * 0.015));
    const slot = {
      left: slotLeft + slotInset,
      right: slotRight - slotInset,
      top: trayTop,
      bottom: trayBottom,
    };
    const detected = detectPieceInSlot({
      pixels: data,
      imageInfo: info,
      slot,
      expectedCellSize: expectedPieceCellSize,
      pieceIndex,
    });
    details.push(detected);
  }
  const pieces = details.map((detail) => detail.matrix);
  return {
    pieces,
    details,
    tray: {
      left: trayLeft,
      right: trayRight,
      top: trayTop,
      bottom: trayBottom,
    },
    boardCellSize,
    expectedPieceCellSize,
  };
}

function detectPieceInSlot({
  pixels,
  imageInfo,
  slot,
  expectedCellSize,
  pieceIndex,
}) {
  const slotWidth = slot.right - slot.left;
  const slotHeight = slot.bottom - slot.top;
  const { mask, threshold, backgroundColor } = buildPieceMask(
    pixels,
    imageInfo,
    slot,
  );
  const dilationRadius = clamp(Math.round(expectedCellSize * 0.055), 1, 4);
  const connectedMask = dilateMask(mask, slotWidth, slotHeight, dilationRadius);
  const components = findConnectedComponents(
    connectedMask,
    slotWidth,
    slotHeight,
  );
  const component = choosePieceComponent(
    components,
    slotWidth,
    slotHeight,
    expectedCellSize,
  );
  if (!component) {
    const error = new Error(`Couldn't detect piece ${pieceIndex + 1}`);
    error.code = "PIECE_DETECTION_FAILED";
    error.pieceIndex = pieceIndex;
    throw error;
  }
  const refinedBox = refineBoundingBox(mask, slotWidth, slotHeight, component);
  const decoded = decodePieceMatrix({
    mask,
    maskWidth: slotWidth,
    maskHeight: slotHeight,
    boundingBox: refinedBox,
    expectedCellSize,
  });
  if (!decoded) {
    const error = new Error(`Couldn't decode piece ${pieceIndex + 1}`);
    error.code = "PIECE_DETECTION_FAILED";
    error.pieceIndex = pieceIndex;
    throw error;
  }
  const globalBoundingBox = {
    left: slot.left + refinedBox.left,
    top: slot.top + refinedBox.top,
    right: slot.left + refinedBox.right,
    bottom: slot.top + refinedBox.bottom,
  };
  console.log(`Detected Piece ${pieceIndex + 1}:`, {
    matrix: decoded.matrix,
    confidence: Number(decoded.confidence.toFixed(3)),
    foregroundThreshold: Number(threshold.toFixed(2)),
    backgroundColor,
    boundingBox: globalBoundingBox,
  });
  console.table(decoded.matrix);
  return {
    index: pieceIndex,
    matrix: decoded.matrix,
    confidence: decoded.confidence,
    foregroundThreshold: threshold,
    backgroundColor,
    boundingBox: globalBoundingBox,
    slot,
  };
}

function buildPieceMask(pixels, imageInfo, slot) {
  const width = slot.right - slot.left;
  const height = slot.bottom - slot.top;
  const redSamples = [];
  const greenSamples = [];
  const blueSamples = [];
  const sampleStep = 3;
  for (let y = slot.top; y < slot.bottom; y += sampleStep) {
    for (let x = slot.left; x < slot.right; x += sampleStep) {
      const index = (y * imageInfo.width + x) * imageInfo.channels;
      redSamples.push(pixels[index]);
      greenSamples.push(pixels[index + 1]);
      blueSamples.push(pixels[index + 2]);
    }
  }
  const backgroundColor = {
    red: median(redSamples),
    green: median(greenSamples),
    blue: median(blueSamples),
  };
  const distances = new Float32Array(width * height);
  const luminance = new Float32Array(width * height);
  const sampledDistances = [];
  for (let localY = 0; localY < height; localY++) {
    const imageY = slot.top + localY;
    for (let localX = 0; localX < width; localX++) {
      const imageX = slot.left + localX;
      const sourceIndex =
        (imageY * imageInfo.width + imageX) * imageInfo.channels;
      const red = pixels[sourceIndex];
      const green = pixels[sourceIndex + 1];
      const blue = pixels[sourceIndex + 2];
      const localIndex = localY * width + localX;
      const distance = Math.sqrt(
        (red - backgroundColor.red) ** 2 +
          (green - backgroundColor.green) ** 2 +
          (blue - backgroundColor.blue) ** 2,
      );
      distances[localIndex] = distance;
      luminance[localIndex] = red * 0.2126 + green * 0.7152 + blue * 0.0722;
      if (localX % sampleStep === 0 && localY % sampleStep === 0)
        sampledDistances.push(distance);
    }
  }
  const distanceMedian = median(sampledDistances);
  const distanceDeviation = median(
    sampledDistances.map((value) => Math.abs(value - distanceMedian)),
  );
  const colorThreshold = clamp(
    distanceMedian + Math.max(10, distanceDeviation * 5),
    18,
    55,
  );
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const left = luminance[y * width + Math.max(0, x - 1)];
      const right = luminance[y * width + Math.min(width - 1, x + 1)];
      const above = luminance[Math.max(0, y - 1) * width + x];
      const below = luminance[Math.min(height - 1, y + 1) * width + x];
      const edgeStrength = Math.abs(right - left) + Math.abs(below - above);
      if (distances[index] >= colorThreshold || edgeStrength >= 32)
        mask[index] = 1;
    }
  }
  return { mask, threshold: colorThreshold, backgroundColor };
}

function choosePieceComponent(
  components,
  slotWidth,
  slotHeight,
  expectedCellSize,
) {
  const minimumSpan = expectedCellSize * 0.4;
  const maximumSpan = expectedCellSize * 5.8;
  const minimumArea = expectedCellSize * expectedCellSize * 0.08;
  const slotCenterX = slotWidth / 2;
  const slotCenterY = slotHeight / 2;
  let best = null;
  for (const component of components) {
    const width = component.right - component.left + 1;
    const height = component.bottom - component.top + 1;
    if (
      width < minimumSpan ||
      height < minimumSpan ||
      width > maximumSpan ||
      height > maximumSpan ||
      component.area < minimumArea
    )
      continue;
    const centerX = (component.left + component.right) / 2;
    const centerY = (component.top + component.bottom) / 2;
    const centerDistance = Math.hypot(
      centerX - slotCenterX,
      centerY - slotCenterY,
    );
    const score = component.area - centerDistance * expectedCellSize * 0.18;
    if (best === null || score > best.score) best = { ...component, score };
  }
  return best;
}

function decodePieceMatrix({
  mask,
  maskWidth,
  maskHeight,
  boundingBox,
  expectedCellSize,
}) {
  const boxWidth = boundingBox.right - boundingBox.left + 1;
  const boxHeight = boundingBox.bottom - boundingBox.top + 1;
  let best = null;
  for (let rows = 1; rows <= MAX_SHAPE_SIZE; rows++) {
    for (let cols = 1; cols <= MAX_SHAPE_SIZE; cols++) {
      const cellWidth = boxWidth / cols;
      const cellHeight = boxHeight / rows;
      const averageCellSize = (cellWidth + cellHeight) / 2;
      const sizeRatio = averageCellSize / expectedCellSize;
      if (sizeRatio < 0.58 || sizeRatio > 1.48) continue;
      const cellAspectError =
        Math.abs(cellWidth - cellHeight) / Math.max(1, averageCellSize);
      const fractions = measureGridFractions({
        mask,
        maskWidth,
        maskHeight,
        boundingBox,
        rows,
        cols,
      });
      const occupancyThreshold = chooseOccupancyThreshold(fractions);
      const matrix = Array.from({ length: rows }, (_, row) =>
        Array.from({ length: cols }, (_, col) =>
          fractions[row * cols + col] >= occupancyThreshold ? 1 : 0,
        ),
      );
      const occupiedCount = matrix.flat().filter((value) => value === 1).length;
      if (occupiedCount === 0 || occupiedCount > MAX_PIECE_BLOCKS) continue;
      if (!touchesEveryBoundingEdge(matrix)) continue;
      if (!isPieceConnected(matrix)) continue;
      const occupiedFractions = [];
      const emptyFractions = [];
      fractions.forEach((fraction, index) => {
        if (matrix[Math.floor(index / cols)][index % cols] === 1)
          occupiedFractions.push(fraction);
        else emptyFractions.push(fraction);
      });
      const occupiedMean = pieceAverage(occupiedFractions);
      const emptyMean = emptyFractions.length
        ? pieceAverage(emptyFractions)
        : 0;
      const separation = occupiedMean - emptyMean;
      const certainty = pieceAverage(
        fractions.map((fraction, index) => {
          const row = Math.floor(index / cols);
          const col = index % cols;
          return matrix[row][col] ? fraction : 1 - fraction;
        }),
      );
      const sizePenalty = Math.abs(Math.log(sizeRatio));
      const score =
        separation * 80 +
        occupiedMean * 25 -
        emptyMean * 35 +
        certainty * 18 -
        sizePenalty * 42 -
        cellAspectError * 38;
      if (best === null || score > best.score)
        best = { score, matrix, rows, cols, fractions, occupancyThreshold };
    }
  }
  if (!best) return null;
  return { ...best, confidence: clamp((best.score + 20) / 110, 0, 1) };
}

function measureGridFractions({
  mask,
  maskWidth,
  maskHeight,
  boundingBox,
  rows,
  cols,
}) {
  const boxWidth = boundingBox.right - boundingBox.left + 1;
  const boxHeight = boundingBox.bottom - boundingBox.top + 1;
  const fractions = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      let left = Math.round(boundingBox.left + (boxWidth * col) / cols);
      let right = Math.round(boundingBox.left + (boxWidth * (col + 1)) / cols);
      let top = Math.round(boundingBox.top + (boxHeight * row) / rows);
      let bottom = Math.round(boundingBox.top + (boxHeight * (row + 1)) / rows);
      const marginX = Math.max(1, Math.round((right - left) * 0.13));
      const marginY = Math.max(1, Math.round((bottom - top) * 0.13));
      left += marginX;
      right -= marginX;
      top += marginY;
      bottom -= marginY;
      left = clamp(left, 0, maskWidth);
      right = clamp(right, 0, maskWidth);
      top = clamp(top, 0, maskHeight);
      bottom = clamp(bottom, 0, maskHeight);
      let filled = 0;
      let total = 0;
      for (let y = top; y < bottom; y++)
        for (let x = left; x < right; x++) {
          filled += mask[y * maskWidth + x];
          total++;
        }
      fractions.push(total > 0 ? filled / total : 0);
    }
  }
  return fractions;
}

function chooseOccupancyThreshold(fractions) {
  const sorted = [...fractions].sort((a, b) => a - b);
  if (!sorted.length) return 0.15;
  let largestGap = 0;
  let threshold = 0.15;
  for (let index = 1; index < sorted.length; index++) {
    const gap = sorted[index] - sorted[index - 1];
    if (gap > largestGap) {
      largestGap = gap;
      threshold = (sorted[index] + sorted[index - 1]) / 2;
    }
  }
  if (largestGap < 0.12)
    threshold = clamp(Math.max(...sorted) * 0.42, 0.08, 0.34);
  return clamp(threshold, 0.08, 0.72);
}

function refineBoundingBox(mask, width, height, component) {
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = component.top; y <= component.bottom; y++)
    for (let x = component.left; x <= component.right; x++)
      if (mask[y * width + x] === 1) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
  if (right < left || bottom < top)
    return {
      left: component.left,
      right: component.right,
      top: component.top,
      bottom: component.bottom,
    };
  return { left, right, top, bottom };
}

function dilateMask(mask, width, height, radius) {
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] !== 1) continue;
      for (let offsetY = -radius; offsetY <= radius; offsetY++)
        for (let offsetX = -radius; offsetX <= radius; offsetX++) {
          const targetX = x + offsetX;
          const targetY = y + offsetY;
          if (
            targetX < 0 ||
            targetX >= width ||
            targetY < 0 ||
            targetY >= height
          )
            continue;
          output[targetY * width + targetX] = 1;
        }
    }
  return output;
}

function findConnectedComponents(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const startingIndex = y * width + x;
      if (mask[startingIndex] !== 1 || visited[startingIndex]) continue;
      let queueStart = 0,
        queueEnd = 0,
        area = 0,
        left = x,
        right = x,
        top = y,
        bottom = y;
      queue[queueEnd++] = startingIndex;
      visited[startingIndex] = 1;
      while (queueStart < queueEnd) {
        const index = queue[queueStart++];
        const currentX = index % width;
        const currentY = Math.floor(index / width);
        area++;
        left = Math.min(left, currentX);
        right = Math.max(right, currentX);
        top = Math.min(top, currentY);
        bottom = Math.max(bottom, currentY);
        for (let offsetY = -1; offsetY <= 1; offsetY++)
          for (let offsetX = -1; offsetX <= 1; offsetX++) {
            if (offsetX === 0 && offsetY === 0) continue;
            const nextX = currentX + offsetX;
            const nextY = currentY + offsetY;
            if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height)
              continue;
            const nextIndex = nextY * width + nextX;
            if (mask[nextIndex] !== 1 || visited[nextIndex]) continue;
            visited[nextIndex] = 1;
            queue[queueEnd++] = nextIndex;
          }
      }
      components.push({ area, left, right, top, bottom });
    }
  return components;
}

function touchesEveryBoundingEdge(matrix) {
  const lastRow = matrix.length - 1;
  const lastCol = matrix[0].length - 1;
  return (
    matrix[0].includes(1) &&
    matrix[lastRow].includes(1) &&
    matrix.some((row) => row[0] === 1) &&
    matrix.some((row) => row[lastCol] === 1)
  );
}

function isPieceConnected(matrix) {
  const occupied = [];
  for (let row = 0; row < matrix.length; row++)
    for (let col = 0; col < matrix[row].length; col++)
      if (matrix[row][col] === 1) occupied.push([row, col]);
  if (!occupied.length) return false;
  const visited = new Set();
  const queue = [occupied[0]];
  visited.add(occupied[0].join(","));
  while (queue.length) {
    const [row, col] = queue.shift();
    for (let rowOffset = -1; rowOffset <= 1; rowOffset++)
      for (let colOffset = -1; colOffset <= 1; colOffset++) {
        if (rowOffset === 0 && colOffset === 0) continue;
        const nextRow = row + rowOffset;
        const nextCol = col + colOffset;
        if (
          nextRow < 0 ||
          nextRow >= matrix.length ||
          nextCol < 0 ||
          nextCol >= matrix[0].length ||
          matrix[nextRow][nextCol] !== 1
        )
          continue;
        const key = `${nextRow},${nextCol}`;
        if (visited.has(key)) continue;
        visited.add(key);
        queue.push([nextRow, nextCol]);
      }
  }
  return visited.size === occupied.length;
}

function validateBoardLocation(boardLocation) {
  const keys = ["left", "right", "top", "bottom", "width", "height"];
  if (
    !boardLocation ||
    keys.some((key) => !Number.isFinite(boardLocation[key]))
  )
    throw new Error("A valid board location is required for piece detection");
}

function median(numbers) {
  if (!numbers.length) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function pieceAverage(numbers) {
  if (!numbers.length) return 0;
  return numbers.reduce((total, number) => total + number, 0) / numbers.length;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

module.exports = { detectPieces };

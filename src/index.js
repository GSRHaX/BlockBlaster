const express = require("express");
const cors = require("cors");
const fs = require("node:fs/promises");
const path = require("node:path");
const app = express();
const sharp = require("sharp");
const PORT = process.env.PORT || 3000;
const UPLOAD_DIRECTORY = path.join(__dirname, "uploads");

const { detectPieces } = require("./pieceDetection");
const { solveBoard } = require("./solver");
const { renderSolutionImage } = require("./renderSolution");

app.set("trust proxy", 1);

async function locateBoard(imageBuffer) {
  const detectionWidth = 500;
  const normalized = sharp(imageBuffer)
    .rotate()
    .removeAlpha()
    .toColourspace("srgb");
  const originalMetadata = await normalized.metadata();

  const resized = await normalized
    .clone()
    .resize({ width: detectionWidth, fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data, info } = resized;

  const gray = makeGrayscale(data, info);

  const verticalSearchTop = Math.floor(info.height * 0.16);

  const verticalSearchBottom = Math.floor(info.height * 0.72);

  const initialVerticalProfile = createVerticalEdgeProfile(
    gray,
    info.width,
    info.height,
    verticalSearchTop,
    verticalSearchBottom,
  );

  const verticalGrid = findBestGridSequence(initialVerticalProfile, {
    lineCount: 9,
    minStart: Math.floor(info.width * 0.01),
    maxStart: Math.floor(info.width * 0.25),
    minSpacing: Math.floor(info.width * 0.07),
    maxSpacing: Math.floor(info.width * 0.14),
    peakRadius: 3,
  });

  if (!verticalGrid) {
    throw new Error("Could not detect the board's vertical grid lines");
  }

  const boardLeftSmall = verticalGrid.positions[0];
  const boardRightSmall = verticalGrid.positions[8];

  const horizontalProfile = createHorizontalEdgeProfile(
    gray,
    info.width,
    info.height,
    Math.max(0, boardLeftSmall - 5),
    Math.min(info.width - 1, boardRightSmall + 5),
  );
  const expectedSpacing = verticalGrid.spacing;

  const horizontalGrid = findBestGridSequence(horizontalProfile, {
    lineCount: 9,
    minStart: Math.floor(info.height * 0.14),
    maxStart: Math.floor(info.height * 0.62),
    minSpacing: Math.floor(expectedSpacing * 0.87),
    maxSpacing: Math.ceil(expectedSpacing * 1.13),
    peakRadius: 3,
  });

  if (!horizontalGrid) {
    throw new Error(
      "Couldn't detect the board's horizontal grid lines, try switching to default theme in settings",
    );
  }

  const scaleX = originalMetadata.width / info.width;
  const scaleY = originalMetadata.height / info.height;

  const xLines = verticalGrid.positions.map((position) =>
    Math.round(position * scaleX),
  );
  const yLines = horizontalGrid.positions.map((position) =>
    Math.round(position * scaleY),
  );

  return {
    left: xLines[0],
    top: yLines[0],
    right: xLines[8],
    bottom: yLines[8],

    width: xLines[8] - xLines[0],
    height: yLines[8] - yLines[0],

    xLines,
    yLines,

    detectionConfidence: calculateGridConfidence(verticalGrid, horizontalGrid),
  };
}

function makeGrayscale(pixels, info) {
  const gray = new Uint8Array(info.width * info.height);

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const sourceIndex = (y * info.width + x) * info.channels;
      const destinationIndex = y * info.width + x;

      const red = pixels[sourceIndex];
      const green = pixels[sourceIndex + 1];
      const blue = pixels[sourceIndex + 2];

      gray[destinationIndex] = Math.round(
        red * 0.2126 + green * 0.7152 + blue * 0.0722,
      );
    }
  }

  return gray;
}

function createVerticalEdgeProfile(gray, width, height, top, bottom) {
  const profile = new Float64Array(width);

  for (let x = 1; x < width - 1; x++) {
    let score = 0;

    for (let y = top; y < bottom; y++) {
      const rowIndex = y * width;

      const left = gray[rowIndex + x - 1];
      const right = gray[rowIndex + x + 1];

      score += Math.abs(right - left);
    }

    profile[x] = score / Math.max(1, bottom - top);
  }

  return profile;
}

function createHorizontalEdgeProfile(gray, width, height, left, right) {
  const profile = new Float64Array(height);

  for (let y = 1; y < height - 1; y++) {
    let score = 0;

    const upperRow = (y - 1) * width;
    const lowerRow = (y + 1) * width;

    for (let x = left; x < right; x++) {
      const upper = gray[upperRow + x];
      const lower = gray[lowerRow + x];
      score += Math.abs(lower - upper);
    }

    profile[y] = score / Math.max(1, right - left);
  }

  return profile;
}

function findBestGridSequence(
  profile,
  { lineCount, minStart, maxStart, minSpacing, maxSpacing, peakRadius },
) {
  let best = null;

  minStart = Math.max(0, minStart);

  maxStart = Math.min(profile.length - 1, maxStart);

  for (let spacing = minSpacing; spacing <= maxSpacing; spacing++) {
    const lastPossibleStart = Math.min(
      maxStart,
      profile.length - 1 - spacing * (lineCount - 1),
    );

    for (let start = minStart; start <= lastPossibleStart; start++) {
      const positions = [];
      const strengths = [];

      for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
        const expectedPosition = start + lineIndex * spacing;

        const peak = findLocalPeak(profile, expectedPosition, peakRadius);

        positions.push(peak.position);
        strengths.push(peak.value);
      }

      const averageStrength = average(strengths);

      const minimumStrength = Math.min(...strengths);

      const spacingError = calculateSpacingError(positions, spacing);

      const strengthVariation = standardDeviation(strengths);

      const score =
        averageStrength * 4 +
        minimumStrength * 2 -
        spacingError * 18 -
        strengthVariation * 0.25;

      if (best === null || score > best.score) {
        best = { score, spacing, positions, strengths, spacingError };
      }
    }
  }

  return best;
}

function findLocalPeak(profile, center, radius) {
  let bestPosition = center;
  let bestValue = -Infinity;

  const start = Math.max(0, center - radius);

  const end = Math.min(profile.length - 1, center + radius);

  for (let position = start; position <= end; position++) {
    if (profile[position] > bestValue) {
      bestValue = profile[position];
      bestPosition = position;
    }
  }

  return {
    position: bestPosition,
    value: bestValue,
  };
}

function calculateSpacingError(positions, expectedSpacing) {
  let totalError = 0;

  for (let index = 1; index < positions.length; index++) {
    const actualSpacing = positions[index] - positions[index - 1];
    totalError += Math.abs(actualSpacing - expectedSpacing);
  }

  return totalError / Math.max(1, positions.length - 1);
}

function calculateGridConfidence(verticalGrid, horizontalGrid) {
  const spacingDifference = Math.abs(
    verticalGrid.spacing - horizontalGrid.spacing,
  );
  const averageSpacing = (verticalGrid.spacing + horizontalGrid.spacing) / 2;

  const spacingAgreement = Math.max(
    0,
    1 - spacingDifference / Math.max(1, averageSpacing),
  );
  const positioningAccuracy = Math.max(
    0,
    1 -
      (verticalGrid.spacingError + horizontalGrid.spacingError) /
        Math.max(1, averageSpacing),
  );

  return Number(
    (spacingAgreement * 0.55 + positioningAccuracy * 0.45).toFixed(3),
  );
}

function average(numbers) {
  return numbers.reduce((total, number) => total + number, 0) / numbers.length;
}

function standardDeviation(numbers) {
  const mean = average(numbers);
  const variance = average(numbers.map((number) => (number - mean) ** 2));

  return Math.sqrt(variance);
}

async function detectBoard(imageBuffer) {
  const detection = await detectBoardMatrix(imageBuffer);

  const contrastThreshold = chooseContrastThreshold(
    detection.cellFeatures.map((cell) => cell.contrast),
  );

  const emptyColor = findEmptyReferenceColor(detection.cellFeatures);

  const matrix = Array.from({ length: 8 }, () => Array(8).fill(0));

  const analyzedCells = detection.cellFeatures.map((cell) => {
    const colorDistance = rgbDistance(cell, emptyColor);

    const occupied = cell.contrast >= contrastThreshold || colorDistance >= 32;

    matrix[cell.row][cell.col] = occupied ? 1 : 0;

    return {
      ...cell,
      colorDistance,
      occupied,
    };
  });

  console.log("Board classifier:", {
    contrastThreshold,
    emptyColor,
    boardLocation: detection.boardLocation,
  });

  console.table(
    analyzedCells.map((cell) => ({
      row: cell.row,
      col: cell.col,

      rgb:
        `${Math.round(cell.red)},` +
        `${Math.round(cell.green)},` +
        `${Math.round(cell.blue)}`,

      contrast: Number(cell.contrast.toFixed(2)),

      colorDistance: Number(cell.colorDistance.toFixed(2)),

      occupied: cell.occupied,
    })),
  );

  console.log("Detected matrix:");

  console.table(matrix);

  return {
    boardLocation: detection.boardLocation,

    matrix,
    cells: analyzedCells,

    contrastThreshold,
    emptyColor,
  };
}

async function detectBoardMatrix(screenshotBuffer) {
  const boardLocation = await locateBoard(screenshotBuffer);

  console.log("Detected board location:", boardLocation);

  const { data, info } = await sharp(screenshotBuffer)
    .rotate()
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({
      resolveWithObject: true,
    });

  const cellFeatures = [];

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = boardLocation.xLines[col];

      const right = boardLocation.xLines[col + 1];

      const top = boardLocation.yLines[row];

      const bottom = boardLocation.yLines[row + 1];

      const marginX = Math.round((right - left) * 0.1);

      const marginY = Math.round((bottom - top) * 0.1);

      const features = measureCellFeatures(
        data,
        info,

        left + marginX,
        top + marginY,

        right - marginX,
        bottom - marginY,
      );

      cellFeatures.push({
        row,
        col,
        ...features,
      });
    }
  }

  return {
    boardLocation,
    cellFeatures,
  };
}

function measureCellFeatures(pixels, info, left, top, right, bottom) {
  left = Math.max(0, Math.floor(left));

  top = Math.max(0, Math.floor(top));

  right = Math.min(info.width, Math.ceil(right));

  bottom = Math.min(info.height, Math.ceil(bottom));

  let redTotal = 0;
  let greenTotal = 0;
  let blueTotal = 0;

  let saturationTotal = 0;
  let luminanceTotal = 0;
  let luminanceSquaredTotal = 0;

  let pixelCount = 0;

  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const index = (y * info.width + x) * info.channels;

      const red = pixels[index];

      const green = pixels[index + 1];

      const blue = pixels[index + 2];

      const maximum = Math.max(red, green, blue);

      const minimum = Math.min(red, green, blue);

      const saturation =
        maximum === 0 ? 0 : ((maximum - minimum) / maximum) * 255;

      const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;

      redTotal += red;
      greenTotal += green;
      blueTotal += blue;

      saturationTotal += saturation;

      luminanceTotal += luminance;

      luminanceSquaredTotal += luminance * luminance;

      pixelCount++;
    }
  }

  if (pixelCount === 0) {
    return {
      red: 0,
      green: 0,
      blue: 0,

      saturation: 0,
      luminance: 0,
      contrast: 0,
    };
  }

  const red = redTotal / pixelCount;

  const green = greenTotal / pixelCount;

  const blue = blueTotal / pixelCount;

  const saturation = saturationTotal / pixelCount;

  const luminance = luminanceTotal / pixelCount;

  const variance = Math.max(
    0,

    luminanceSquaredTotal / pixelCount - luminance * luminance,
  );

  return {
    red,
    green,
    blue,

    saturation,
    luminance,
    contrast: Math.sqrt(variance),
  };
}

function chooseContrastThreshold(values) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);

  if (sorted.length < 2) {
    return 6;
  }

  let largestGap = 0;
  let threshold = 6;

  for (let index = 1; index < sorted.length; index++) {
    const gap = sorted[index] - sorted[index - 1];

    if (gap > largestGap) {
      largestGap = gap;

      threshold = (sorted[index] + sorted[index - 1]) / 2;
    }
  }
  return Math.min(12, Math.max(3, threshold));
}

function findEmptyReferenceColor(cells) {
  const COLOR_CLUSTER_RADIUS = 18;

  const possibleGroups = cells.map((seed) => {
    const members = cells.filter(
      (cell) => rgbDistance(seed, cell) <= COLOR_CLUSTER_RADIUS,
    );

    return {
      members,

      averageContrast: average(members.map((cell) => cell.contrast)),
    };
  });

  const flatGroups = possibleGroups.filter(
    (group) => group.averageContrast < 5,
  );

  const usableGroups = flatGroups.length > 0 ? flatGroups : possibleGroups;

  usableGroups.sort((a, b) => {
    if (b.members.length !== a.members.length) {
      return b.members.length - a.members.length;
    }

    return a.averageContrast - b.averageContrast;
  });

  const bestGroup = usableGroups[0];

  return {
    red: average(bestGroup.members.map((cell) => cell.red)),

    green: average(bestGroup.members.map((cell) => cell.green)),

    blue: average(bestGroup.members.map((cell) => cell.blue)),
  };
}

function rgbDistance(colorA, colorB) {
  return Math.sqrt(
    (colorA.red - colorB.red) ** 2 +
      (colorA.green - colorB.green) ** 2 +
      (colorA.blue - colorB.blue) ** 2,
  );
}

function squaredDistance(pointA, pointB) {
  return (pointA[0] - pointB[0]) ** 2 + (pointA[1] - pointB[1]) ** 2;
}

app.use((req, res, next) => {
  console.log({
    method: req.method,
    url: req.originalUrl,
    contentType: req.get("content-type"),
    contentLength: req.get("content-length"),
  });

  next();
});

app.post(
  "/solve",

  express.raw({
    type: () => true,
    limit: "15mb",
  }),

  async (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({
          success: false,
          error: "No screenshot was received",
        });
      }

      await fs.mkdir(UPLOAD_DIRECTORY, {
        recursive: true,
      });

      const screenshotBuffer = await sharp(req.body).rotate().png().toBuffer();

      const boardDetection = await detectBoard(screenshotBuffer);

      const detectedBoard = boardDetection.matrix;

      console.table(detectedBoard);

      const pieceDetection = await detectPieces(
        screenshotBuffer,
        boardDetection.boardLocation,
      );

      const detectedPieces = pieceDetection.pieces;

      console.log("Detected pieces:");

      detectedPieces.forEach((piece, index) => {
        console.log(`Piece ${index + 1}`);

        console.table(piece);
      });

      const solution = solveBoard(detectedBoard, detectedPieces, {
        streak: 0,
        misses: 0,
      });

      if (!solution) {
        return res.status(422).json({
          success: false,
          error: "No valid solution was found",

          board: detectedBoard,
          pieces: detectedPieces,
        });
      }

      const solutionImage = await renderSolutionImage(solution);

      return res
        .status(200)
        .set({
          "Content-Type": "image/png",

          "Cache-Control": "no-store",
        })
        .send(solutionImage);
    } catch (error) {
      next(error);
    }
  },
);

app.use(
  express.json({
    limit: "1mb",
  }),
);

app.listen(PORT, () => {
  console.log(`Block Blast server running on port ${PORT}`);

  console.log(`Local URL: http://localhost:${PORT}`);
});

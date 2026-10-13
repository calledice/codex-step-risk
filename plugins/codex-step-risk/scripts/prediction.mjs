const validProbability = value =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

export function composePrediction({ failureRisk, conditionalOrigin, currentEventId = null }) {
  const riskCalibrated = failureRisk?.status === 'calibrated' &&
    validProbability(failureRisk.value)
  const riskModelEstimate = failureRisk?.status === 'assumption_based_uncalibrated' &&
    validProbability(failureRisk.value)
  const candidates = Array.isArray(conditionalOrigin?.candidates)
    ? conditionalOrigin.candidates : []
  const totalOriginWeight = candidates.reduce((sum, candidate) => sum + candidate.weight, 0) +
    conditionalOrigin?.residualWeight + conditionalOrigin?.otherWeight
  const originCalibrated = conditionalOrigin?.status === 'calibrated' &&
    validProbability(conditionalOrigin.residualWeight) &&
    validProbability(conditionalOrigin.otherWeight) &&
    candidates.every(candidate => validProbability(candidate.weight)) &&
    Math.abs(totalOriginWeight - 1) < 1e-8
  const calibrated = riskCalibrated && originCalibrated
  const riskStatus = failureRisk?.status === 'calibrated' && !riskCalibrated
    ? 'invalid_calibration' : failureRisk?.status === 'assumption_based_uncalibrated' &&
      !riskModelEstimate ? 'invalid_model_estimate' :
      failureRisk?.status ?? 'unavailable_no_success_data'
  const originStatus = conditionalOrigin?.status === 'calibrated' && !originCalibrated
    ? 'invalid_calibration' : conditionalOrigin?.status ?? 'experimental_uncalibrated'
  const jointCandidates = candidates.map(candidate => ({
    eventId: candidate.eventId,
    value: calibrated ? failureRisk.value * candidate.weight : null,
  }))
  return {
    taskFailureRisk: riskCalibrated
      ? { status: 'calibrated', value: failureRisk.value }
      : riskModelEstimate ? { ...failureRisk }
        : { status: riskStatus, value: null },
    conditionalOrigin: {
      status: originStatus,
      candidates,
      residualWeight: conditionalOrigin?.residualWeight ?? null,
      otherWeight: conditionalOrigin?.otherWeight ?? null,
    },
    jointOriginFailure: {
      status: calibrated ? 'calibrated' : 'unavailable_uncalibrated_components',
      value: calibrated
        ? jointCandidates.find(candidate => candidate.eventId === currentEventId)?.value ?? null
        : null,
      candidates: jointCandidates,
      residualValue: calibrated
        ? failureRisk.value * conditionalOrigin.residualWeight : null,
      otherValue: calibrated
        ? failureRisk.value * conditionalOrigin.otherWeight : null,
    },
  }
}

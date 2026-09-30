use std::{env, process::ExitCode};

use sigpilot_graph::performance_self_test::{
    human_summary, run, validate_config, write_report, ScenarioKind, ScenarioSelection,
    SelfTestConfig, DEFAULT_POLL_INTERVAL_MS,
};

fn main() -> ExitCode {
    let args = match parse_args(env::args().skip(1)) {
        Ok(Some(config)) => config,
        Ok(None) => {
            print_usage();
            return ExitCode::SUCCESS;
        }
        Err(error) => {
            eprintln!("sigpilot-perf-self-test: {error}");
            print_usage();
            return ExitCode::from(2);
        }
    };
    if let Err(error) = validate_config(&args, cfg!(not(debug_assertions))) {
        eprintln!("sigpilot-perf-self-test: {error}");
        return ExitCode::from(2);
    }

    let report = run(&args);
    eprintln!("{}", human_summary(&report));
    if let Err(error) = write_report(&report, args.output.as_deref()) {
        eprintln!("sigpilot-perf-self-test: failed to write report: {error}");
        return ExitCode::from(1);
    }
    if report
        .scenarios
        .iter()
        .any(|scenario| scenario.status == "failed")
    {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}

fn parse_args<I>(arguments: I) -> Result<Option<SelfTestConfig>, String>
where
    I: IntoIterator<Item = String>,
{
    let mut config = SelfTestConfig::default();
    let mut selected_scenarios = Vec::new();
    let mut arguments = arguments.into_iter();
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--help" | "-h" => return Ok(None),
            "--samples" => {
                config.sample_sizes = parse_samples(&next_value(&mut arguments, "--samples")?)?;
            }
            "--scenario" => {
                selected_scenarios
                    .push(parse_scenario(&next_value(&mut arguments, "--scenario")?)?);
            }
            "--warmups" => {
                config.warmup_iterations =
                    parse_positive(&next_value(&mut arguments, "--warmups")?, "warmups")?;
            }
            "--iterations" => {
                config.measured_iterations =
                    parse_positive(&next_value(&mut arguments, "--iterations")?, "iterations")?;
            }
            "--poll-ms" => {
                config.poll_interval_ms =
                    next_value(&mut arguments, "--poll-ms")?
                        .parse::<u64>()
                        .map_err(|_| "--poll-ms must be an integer".to_string())?;
            }
            "--output" => {
                config.output = Some(next_value(&mut arguments, "--output")?);
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }
    if !selected_scenarios.is_empty() {
        config.scenarios = selected_scenarios;
        config.sample_sizes = config
            .scenarios
            .iter()
            .map(|scenario| scenario.sample_count)
            .collect();
        config.sample_sizes.sort_unstable();
        config.sample_sizes.dedup();
    }
    Ok(Some(config))
}

fn next_value(arguments: &mut impl Iterator<Item = String>, name: &str) -> Result<String, String> {
    arguments
        .next()
        .ok_or_else(|| format!("{name} requires a value"))
}

fn parse_positive(value: &str, name: &str) -> Result<usize, String> {
    let parsed = value
        .parse::<usize>()
        .map_err(|_| format!("--{name} must be a positive integer"))?;
    if parsed == 0 {
        return Err(format!("--{name} must be at least 1"));
    }
    Ok(parsed)
}

fn parse_samples(value: &str) -> Result<Vec<u64>, String> {
    let samples = value
        .split(',')
        .map(|item| item.trim().parse::<u64>())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "--samples must be comma-separated positive integers".to_string())?;
    if samples.is_empty() || samples.iter().any(|sample| *sample == 0) {
        return Err("--samples must contain at least one positive integer".to_string());
    }
    Ok(samples)
}

fn parse_scenario(value: &str) -> Result<ScenarioSelection, String> {
    let (sample, protocol) = if let Some((sample, protocol)) = value.split_once('-') {
        (sample, protocol)
    } else {
        return Err("scenario must look like 2.5m-i2c-spi or 250000-uart".to_string());
    };
    let sample_count = match sample.to_ascii_lowercase().as_str() {
        "250k" => 250_000,
        "2.5m" => 2_500_000,
        "25m" => 25_000_000,
        value => value
            .parse::<u64>()
            .map_err(|_| format!("unknown sample size {value}"))?,
    };
    let kind = match protocol {
        "uart" => ScenarioKind::Uart,
        "i2c" => ScenarioKind::I2c,
        "spi" => ScenarioKind::Spi,
        "i2c-spi" => ScenarioKind::I2cSpi,
        value => return Err(format!("unknown protocol scenario {value}")),
    };
    Ok(ScenarioSelection { sample_count, kind })
}

fn print_usage() {
    eprintln!(
        "Usage: cargo run --release -p sigpilot-graph --bin sigpilot-perf-self-test -- [options]\n\
         Defaults: all 250K/2.5M/25M x UART/I2C/SPI/I2C+SPI, 1 warmup, 10 measured runs.\n\
         Options: --scenario 2.5m-i2c-spi --samples 250000,2500000 --warmups 1 \
         --iterations 10 --poll-ms {DEFAULT_POLL_INTERVAL_MS} --output report.json"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_representative_scenario() {
        let config = parse_args(
            [
                "--scenario".to_string(),
                "2.5m-i2c-spi".to_string(),
                "--iterations".to_string(),
                "10".to_string(),
            ]
            .into_iter(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(config.scenarios.len(), 1);
        assert_eq!(config.scenarios[0].sample_count, 2_500_000);
        assert_eq!(config.scenarios[0].kind, ScenarioKind::I2cSpi);
        assert_eq!(config.measured_iterations, 10);
    }

    #[test]
    fn rejects_missing_and_zero_arguments() {
        assert!(parse_args(["--scenario".to_string()].into_iter()).is_err());
        assert!(parse_args(["--iterations".to_string(), "0".to_string()].into_iter()).is_err());
    }
}

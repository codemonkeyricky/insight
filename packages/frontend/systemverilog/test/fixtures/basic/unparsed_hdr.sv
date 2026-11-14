module prim_alert_sender
  import prim_alert_pkg::*;
#(
  // enables additional synchronization logic
  parameter bit AsyncOn = 1'b1,
  // Number of cycles a differential skew is tolerated on the differential ack/ping signal.
  parameter int unsigned SkewCycles = 1,
  // alert sender will latch the incoming alert event permanently and
  // keep on sending alert events until the next reset.
  parameter bit IsFatal = 1'b0
) (
  input             clk_i,
  input             rst_ni,
  // alert test trigger (this will never be latched, even if IsFatal == 1)
  input             alert_test_i,
  // native alert from the peripheral
  input             alert_req_i,
  output logic      alert_ack_o,
  // state of the alert latching register
  output logic      alert_state_o,
endmodule

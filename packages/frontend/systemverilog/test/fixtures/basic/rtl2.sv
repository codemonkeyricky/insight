module rtl_nonansi(a, b, c);
  parameter type T = logic;
  input a;
  output b;
  input logic c;
  logic [3:0] cnt;

  function automatic int f(int x);
    return x;
  endfunction

  assign b = f(a);

  initial begin : boot
    integer fd;
    fd = $fopen("log.txt", "w");
  end

  always_ff @(posedge c) begin : seq_proc
    cnt <= cnt + 1;
  end

  always_comb begin : comb_blk
    for (int i = 0; i < 4; i++) begin
      if (i == 2) break;
    end
  end

  if (1) begin : g1
    function automatic int pick();
      return 1;
    endfunction
    assign cnt = pick();
  end else begin : g2
    function automatic int pick();
      return 2;
    endfunction
  end

  if (1) begin
    function automatic int h();
      return 1;
    endfunction
  end else begin
    function automatic int h();
      return 2;
    endfunction
  end

  initial begin
    foreach (cnt[i]) begin
      disable blk_x;
    end
  end
endmodule

module ansi_if #(parameter type T = logic) (input logic a, bus_if.mst b, output logic y);
  assign y = a;
endmodule

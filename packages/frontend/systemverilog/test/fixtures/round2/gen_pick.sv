module gen_pick;
  if (1) begin : g1
    function automatic int pick(int x);
      return x;
    endfunction
    initial pick(1);
  end
  if (1) begin : g2
    function automatic int pick(int x);
      return x;
    endfunction
    initial pick(2);
  end
  initial pick(3);
endmodule

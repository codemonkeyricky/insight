module fopen_m;
  string mode_var;
  integer fd;
  initial begin
    fd = $fopen("out.txt", mode_var);
  end
endmodule
